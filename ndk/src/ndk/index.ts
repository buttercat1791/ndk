import debug from "debug";
import EventEmitter from "eventemitter3";

import type { NDKCacheAdapter } from "../cache/index.js";
import dedupEvent from "../events/dedup.js";
import type { NDKEvent, NDKEventId } from "../events/index.js";
import { OutboxTracker } from "../outbox/tracker.js";
import { NDKRelay, NDKRelayUrl } from "../relay/index.js";
import { NDKPool } from "../relay/pool/index.js";
import { NDKRelaySet } from "../relay/sets/index.js";
import { correctRelaySet } from "../relay/sets/utils.js";
import type { NDKSigner } from "../signers/index.js";
import type { NDKFilter, NDKSubscriptionOptions } from "../subscription/index.js";
import { NDKSubscription } from "../subscription/index.js";
import { filterFromId, isNip33AValue, relaysFromBech32 } from "../subscription/utils.js";
import type { Hexpubkey, NDKUserParams } from "../user/index.js";
import { NDKUser } from "../user/index.js";
import { NDKKind } from "../events/kinds/index.js";
import NDKList from "../events/kinds/lists/index.js";

export interface NDKConstructorParams {
    /**
     * Relays we should explicitly connect to
     */
    explicitRelayUrls?: string[];

    /**
     * Relays we should never connect to
     */
    blacklistRelayUrls?: string[];

    /**
     * When this is set, we always write only to this relays.
     */
    devWriteRelayUrls?: string[];

    /**
     * Outbox relay URLs.
     */
    outboxRelayUrls?: string[];

    /**
     * Enable outbox model (defaults to false)
     */
    enableOutboxModel?: boolean;

    /**
     * Auto-connect to main user's relays. The "main" user is determined
     * by the presence of a signer. Upon connection to the explicit relays,
     * the user's relays will be fetched and connected to if this is set to true.
     * @default true
     */
    autoConnectUserRelays?: boolean;

    /**
     * Automatically fetch user's mutelist
     * @default true
     */
    autoFetchUserMutelist?: boolean;

    /**
     * Signer to use for signing events by default
     */
    signer?: NDKSigner;

    /**
     * Cache adapter to use for caching events
     */
    cacheAdapter?: NDKCacheAdapter;

    /**
     * Debug instance to use
     */
    debug?: debug.Debugger;

    /**
     * Muted pubkeys and eventIds
     */
    mutedIds?: Map<Hexpubkey | NDKEventId, string>;
}

export interface GetUserParams extends NDKUserParams {
    npub?: string;
    hexpubkey?: string;
}

export const DEFAULT_OUTBOX_RELAYS = ["wss://purplepag.es", "wss://relay.snort.social"];

export const DEFAULT_BLACKLISTED_RELAYS = [
    "wss://brb.io", // BRB
];

export class NDK extends EventEmitter {
    public explicitRelayUrls?: NDKRelayUrl[];
    public pool: NDKPool;
    public outboxPool?: NDKPool;
    private _signer?: NDKSigner;
    private _activeUser?: NDKUser;
    public cacheAdapter?: NDKCacheAdapter;
    public debug: debug.Debugger;
    public devWriteRelaySet?: NDKRelaySet;
    public outboxTracker?: OutboxTracker;
    public mutedIds: Map<Hexpubkey | NDKEventId, string>;

    private autoConnectUserRelays = true;
    private autoFetchUserMutelist = true;

    public constructor(opts: NDKConstructorParams = {}) {
        super();

        this.debug = opts.debug || debug("ndk");
        this.explicitRelayUrls = opts.explicitRelayUrls;
        this.pool = new NDKPool(opts.explicitRelayUrls || [], opts.blacklistRelayUrls, this);

        this.debug(`Starting with explicit relays: ${JSON.stringify(this.explicitRelayUrls)}`);

        this.autoConnectUserRelays = opts.autoConnectUserRelays ?? true;
        this.autoFetchUserMutelist = opts.autoFetchUserMutelist ?? true;

        if (opts.enableOutboxModel) {
            this.outboxPool = new NDKPool(
                opts.outboxRelayUrls || DEFAULT_OUTBOX_RELAYS,
                opts.blacklistRelayUrls || DEFAULT_BLACKLISTED_RELAYS,
                this,
                this.debug.extend("outbox-pool")
            );

            this.outboxTracker = new OutboxTracker(this);
        }

        this.signer = opts.signer;
        this.cacheAdapter = opts.cacheAdapter;
        this.mutedIds = opts.mutedIds || new Map();

        if (opts.devWriteRelayUrls) {
            this.devWriteRelaySet = NDKRelaySet.fromRelayUrls(opts.devWriteRelayUrls, this);
        }
    }

    public toJSON(): string {
        return { relayCount: this.pool.relays.size }.toString();
    }

    public get activeUser(): NDKUser | undefined {
        return this._activeUser;
    }

    /**
     * Sets the active user for this NDK instance, typically this will be
     * called when assigning a signer to the NDK instance.
     *
     * This function will automatically connect to the user's relays if
     * `autoConnectUserRelays` is set to true.
     *
     * It will also fetch the user's mutelist if `autoFetchUserMutelist` is set to true.
     */
    public set activeUser(user: NDKUser | undefined) {
        const differentUser = this._activeUser !== user;

        this._activeUser = user;

        if (user && differentUser) {
            const connectToUserRelays = async (user: NDKUser) => {
                const relayList = await user.relayList();

                if (!relayList) {
                    this.debug("No relay list found for user", { npub: user.npub });
                    return;
                }

                this.debug("Connecting to user relays", {
                    npub: user.npub,
                    relays: relayList.relays,
                });
                for (const url of relayList.relays) {
                    let relay = this.pool.relays.get(url);
                    if (!relay) {
                        relay = new NDKRelay(url);
                        this.pool.addRelay(relay);
                    }
                }
            };

            const fetchUserMuteList = async (user: NDKUser) => {
                const muteLists = await this.fetchEvents([
                    { kinds: [NDKKind.MuteList], authors: [user.pubkey] },
                    {
                        kinds: [NDKKind.CategorizedPeopleList],
                        authors: [user.pubkey],
                        "#d": ["mute"],
                        limit: 1,
                    },
                ]);

                if (!muteLists) {
                    this.debug("No mute list found for user", { npub: user.npub });
                    return;
                }

                for (const muteList of muteLists) {
                    const list = NDKList.from(muteList);

                    for (const item of list.items) {
                        this.mutedIds.set(item[1], item[0]);
                    }
                }
            };

            const userFunctions: ((user: NDKUser) => Promise<void>)[] = [];

            if (this.autoConnectUserRelays) userFunctions.push(connectToUserRelays);
            if (this.autoFetchUserMutelist) userFunctions.push(fetchUserMuteList);

            const runUserFunctions = async (user: NDKUser) => {
                for (const fn of userFunctions) {
                    await fn(user);
                }
            };

            const pool = this.outboxPool || this.pool;

            if (pool.connectedRelays.length > 0) {
                runUserFunctions(user);
            } else {
                this.debug("Waiting for connection to main relays");
                pool.once("relay:connect", (relay: NDKRelay) => {
                    this.debug("New relay came online", relay);
                    runUserFunctions(user);
                });
            }
        } else if (!user) {
            // reset mutedIds
            this.mutedIds = new Map();
        }
    }

    public get signer(): NDKSigner | undefined {
        return this._signer;
    }

    public set signer(newSigner: NDKSigner | undefined) {
        this._signer = newSigner;

        this.debug(`setting signer`, this.autoConnectUserRelays);

        newSigner?.user().then((user) => {
            user.ndk = this;
            this.activeUser = user;
        });
    }

    /**
     * Connect to relays with optional timeout.
     * If the timeout is reached, the connection will be continued to be established in the background.
     */
    public async connect(timeoutMs?: number): Promise<void> {
        const connections = [this.pool.connect(timeoutMs)];

        if (this.outboxPool) {
            connections.push(this.outboxPool.connect(timeoutMs));
        }

        this.debug("Connecting to relays", { timeoutMs });

        // eslint-disable-next-line @typescript-eslint/no-empty-function
        return Promise.allSettled(connections).then(() => {});
    }

    /**
     * Get a NDKUser object
     *
     * @param opts
     * @returns
     */
    public getUser(opts: GetUserParams): NDKUser {
        const user = new NDKUser(opts);
        user.ndk = this;
        return user;
    }

    /**
     * Create a new subscription. Subscriptions automatically start, you can make them automatically close when all relays send back an EOSE by setting `opts.closeOnEose` to `true`)
     *
     * @param filters
     * @param opts
     * @param relaySet explicit relay set to use
     * @param autoStart automatically start the subscription
     * @returns NDKSubscription
     */
    public subscribe(
        filters: NDKFilter | NDKFilter[],
        opts?: NDKSubscriptionOptions,
        relaySet?: NDKRelaySet,
        autoStart = true
    ): NDKSubscription {
        const subscription = new NDKSubscription(this, filters, opts, relaySet);

        // Signal to the relays that they are explicitly being used
        if (relaySet) {
            for (const relay of relaySet.relays) {
                this.pool.useTemporaryRelay(relay);
            }
        }

        // if we have an authors filter and we are using the outbox pool,
        // we want to track the authors in the outbox tracker
        if (this.outboxPool && subscription.hasAuthorsFilter()) {
            const authors: string[] = subscription.filters
                .filter((filter) => filter.authors && filter.authors?.length > 0)
                .map((filter) => filter.authors!)
                .flat();

            this.outboxTracker?.trackUsers(authors);
        }

        if (autoStart) subscription.start();

        return subscription;
    }

    /**
     * Publish an event to a relay
     * @param event event to publish
     * @param relaySet explicit relay set to use
     * @param timeoutMs timeout in milliseconds to wait for the event to be published
     * @returns The relays the event was published to
     *
     * @deprecated Use `event.publish()` instead
     */
    public async publish(
        event: NDKEvent,
        relaySet?: NDKRelaySet,
        timeoutMs?: number
    ): Promise<Set<NDKRelay>> {
        this.debug("Deprecated: Use `event.publish()` instead");

        return event.publish(relaySet, timeoutMs);
    }

    /**
     * Fetch a single event.
     *
     * @param idOrFilter event id in bech32 format or filter
     * @param opts subscription options
     * @param relaySet explicit relay set to use
     */
    public async fetchEvent(
        idOrFilter: string | NDKFilter,
        opts?: NDKSubscriptionOptions,
        relaySet?: NDKRelaySet
    ): Promise<NDKEvent | null> {
        let filter: NDKFilter;

        // if no relayset has been provided, try to get one from the event id
        if (!relaySet && typeof idOrFilter === "string") {
            /* Check if this is a NIP-33 */
            if (!isNip33AValue(idOrFilter)) {
                const relays = relaysFromBech32(idOrFilter);

                if (relays.length > 0) {
                    relaySet = new NDKRelaySet(new Set<NDKRelay>(relays), this);

                    // Make sure we have connected relays in this set
                    relaySet = correctRelaySet(relaySet, this.pool);
                }
            }
        }

        if (typeof idOrFilter === "string") {
            filter = filterFromId(idOrFilter);
        } else {
            filter = idOrFilter;
        }

        if (!filter) {
            throw new Error(`Invalid filter: ${JSON.stringify(idOrFilter)}`);
        }

        return new Promise((resolve) => {
            const s = this.subscribe(
                filter,
                { ...(opts || {}), closeOnEose: true },
                relaySet,
                false
            );
            s.on("event", (event) => {
                event.ndk = this;
                resolve(event);
            });

            s.on("eose", () => {
                resolve(null);
            });

            s.start();
        });
    }

    /**
     * Fetch events
     */
    public async fetchEvents(
        filters: NDKFilter | NDKFilter[],
        opts?: NDKSubscriptionOptions,
        relaySet?: NDKRelaySet
    ): Promise<Set<NDKEvent>> {
        return new Promise((resolve) => {
            const events: Map<string, NDKEvent> = new Map();

            const relaySetSubscription = this.subscribe(
                filters,
                { ...(opts || {}), closeOnEose: true },
                relaySet,
                false
            );

            const onEvent = (event: NDKEvent) => {
                const dedupKey = event.deduplicationKey();

                const existingEvent = events.get(dedupKey);
                if (existingEvent) {
                    event = dedupEvent(existingEvent, event);
                }

                event.ndk = this;
                events.set(dedupKey, event);
            };

            // We want to inspect duplicated events
            // so we can dedup them
            relaySetSubscription.on("event", onEvent);
            relaySetSubscription.on("event:dup", onEvent);

            relaySetSubscription.on("eose", () => {
                resolve(new Set(events.values()));
            });

            relaySetSubscription.start();
        });
    }

    /**
     * Ensures that a signer is available to sign an event.
     */
    public assertSigner() {
        if (!this.signer) {
            this.emit("signerRequired");
            throw new Error("Signer required");
        }
    }
}
