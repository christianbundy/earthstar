import sqlite = require('better-sqlite3');
import {
    Database as SqliteDatabase
} from 'better-sqlite3';
import {
    IStore,
    ItemToSet,
    Item,
    QueryOpts,
    SyncOpts,
    SyncResults,
    WorkspaceId,
} from './types';
import {
    itemIsValid,
    signItem
} from './storeUtils';

let log = console.log;
log = (...args : any[]) => void {};  // turn off logging for now

export class StoreSqlite implements IStore {
    db : SqliteDatabase;
    workspace : WorkspaceId;
    constructor(workspace : WorkspaceId, dbFilename : string = ':memory:') {
        this.workspace = workspace;
        this.db = sqlite(dbFilename);
        this._ensureTables();
    }
    _ensureTables() {
        // later we might decide to allow multiple items in a key history for a single author,
        // but for now the schema disallows that by having this particular primary key.
        this.db.prepare(`
            CREATE TABLE IF NOT EXISTS items (
                schema TEXT NOT NULL,
                workspace TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                timestamp NUMBER NOT NULL,
                author TEXT NOT NULL,
                signature TEXT NOT NULL,
                PRIMARY KEY(key, author)
            );
        `).run();
    }

    items(query? : QueryOpts) : Item[] {
        if (query === undefined) { query = {}; }
        log(`---- items(${JSON.stringify(query)})`);

        // convert the query into an array of SQL clauses
        let filters : string[] = [];
        let params : {[k:string] : any} = {};
        if (query.key !== undefined) {
            filters.push('key = :key');
            params.key = query.key;
        }
        if (query.lowKey !== undefined) {
            filters.push(':lowKey <= key');
            params.lowKey = query.lowKey;
        }
        if (query.highKey !== undefined) {
            filters.push('key < :highKey');
            params.highKey = query.highKey;
        }
        if (query.prefix !== undefined) {
            filters.push("key LIKE (:prefix || '%') ESCAPE '\\'");
            // escape existing % and _ in the prefix
            // so they don't count as wildcards for LIKE
            params.prefix = query.prefix
                .split('_').join('\\_')
                .split('%').join('\\%');
        }

        let combinedFilters = '';
        if (filters.length > 0) {
            combinedFilters = 'WHERE ' + filters.join('\nAND ')
        }
        log('filters', filters);
        log('combinedFilters', combinedFilters);

        let limitClause = '';
        if (query.limit !== undefined && query.limit > 0) {
            limitClause = 'LIMIT :limit'
            params.limit = query.limit;
        }

        let queryString = '';
        if (query.includeHistory) {
            // when including history, just get all items
            queryString = `
                SELECT * FROM ITEMS
                ${combinedFilters}
                ORDER BY key ASC, timestamp DESC, signature DESC  -- break ties with signature
                ${limitClause};
            `;
        } else {
            // when not including history, only get the latest item per key (from any author)
            queryString = `
                SELECT schema, workspace, key, author, value, MAX(timestamp) as timestamp, signature FROM items
                ${combinedFilters}
                GROUP BY key
                ORDER BY key ASC, timestamp DESC, signature DESC  -- break ties with signature
                ${limitClause};
            `;
        }
        log('items query', query);
        log('items queryString', queryString);
        log('items params', params);
        let items = this.db.prepare(queryString).all(params);
        log('result:', items);
        return items;
    }
    keys(query? : QueryOpts) : string[] {
        // do query without including history, so we get one
        // item per key.  this way the limit parameter works as
        // expected in the case of keys.
        log(`---- keys(${JSON.stringify(query)})`);
        return this.items({...query, includeHistory: false})
            .map(item => item.key);
    }
    values(query? : QueryOpts) : string[] {
        // get items that match the query, sort by key, and return their values.
        // If you set includeHistory you'll get historical values mixed in.
        log(`---- values(${JSON.stringify(query)})`);
        return this.items(query).map(item => item.value);
    }

    getItem(key : string) : Item | undefined {
        // look up the winning value for a single key.
        // return undefined if not found.
        // to get history items for a key, do items({key: 'foo', includeHistory: true})
        log(`---- getItem(${JSON.stringify(key)})`);
        let result : any = this.db.prepare(`
            SELECT * FROM items
            WHERE key = :key 
            ORDER BY timestamp DESC, signature DESC  -- break ties with signature
            LIMIT 1;
        `).get({ key: key });
        log('getItem result:', result);
        return result;
    }
    getValue(key : string) : string | undefined {
        // same as getItem, but just returns the value, not the whole item object.
        log(`---- getValue(${JSON.stringify(key)})`);
        return this.getItem(key)?.value;
    }

    ingestItem(item : Item, futureCutoff? : number) : boolean {
        // Given an item from elsewhere, validate, decide if we want it, and possibly store it.
        // Return true if we kept it, false if we rejected it.

        // It can be rejected if it's not the latest one from the same author,
        // or if the item is invalid (signature, etc).

        // Within a single key we keep the one latest item from each author.
        // So this overwrites older items from the same author - they are forgotten.
        // If it's from a new author for this key, we keep it no matter the timestamp.
        // The winning item is chosen at get time, not write time.

        // futureCutoff is a timestamp in microseconds.
        // Messages from after that are ignored.
        // Defaults to now + 10 minutes.
        // This prevents malicious peers from sending very high timestamps.
        log(`---- ingestItem`);
        log('item:', item);

        if (!itemIsValid(item, futureCutoff)) { return false; }

        // check if it's newer than existing item from same author, same key
        let existingSameAuthorSameKey = this.db.prepare(`
            SELECT * FROM items
            WHERE key = :key
            AND author = :author
            ORDER BY timestamp DESC
            LIMIT 1;
        `).get({ key: item.key, author: item.author });
        
        // Compare timestamps.
        // Compare signature to break timestamp ties.
        if (existingSameAuthorSameKey !== undefined
            && [item.timestamp, item.signature]
            <= [existingSameAuthorSameKey.timestamp, existingSameAuthorSameKey.signature]
            ) {
            // incoming item is older or identical.  ignore it.
            return false;
        }

        // Insert new item, replacing old item if there is one
        this.db.prepare(`
            INSERT OR REPLACE INTO items (schema, workspace, key, value, timestamp, author, signature)
            VALUES (:schema, :workspace, :key, :value, :timestamp, :author, :signature);
        `).run(item);
        return true;
    }

    set(itemToSet : ItemToSet) : boolean {
        // Store a value.
        // schema should normally be omitted so it takes on the default
        // value of the latest version of 'kw.#'.
        // Timestamp is optional and should normally be omitted or set to 0,
        // in which case it will be set to now().
        // (New writes should always have a timestamp of now() except during
        // unit testing or if you're importing old data.)
        log(`---- set(${JSON.stringify(itemToSet.key)}, ${JSON.stringify(itemToSet.value)}, ...)`);

        itemToSet.timestamp = itemToSet.timestamp || 0;
        let item : Item = {
            schema: itemToSet.schema || 'kw.1',  // TODO: make KW_LATEST var
            workspace: this.workspace,
            key: itemToSet.key,
            value: itemToSet.value,
            author: itemToSet.author,
            timestamp: itemToSet.timestamp > 0 ? itemToSet.timestamp : Date.now()*1000,
            signature: '',
        }

        // If there's an existing item from anyone,
        // make sure our timestamp is greater
        // even if this puts us slightly into the future.
        // (We know about the existing item so let's assume we want to supercede it.)
        let existingItemTimestamp = this.getItem(item.key)?.timestamp || 0;
        item.timestamp = Math.max(item.timestamp, existingItemTimestamp+1);

        let signedItem = signItem(item, itemToSet.authorSecret);
        return this.ingestItem(signedItem, item.timestamp);
    }

    _syncFrom(otherStore : IStore, existing : boolean, live : boolean) : number {
        // Pull all items from the other Store and ingest them one by one.
        let numSuccess = 0;
        if (live) {
            // TODO
            throw "live sync not implemented yet";
        }
        if (existing) {
            for (let item of otherStore.items({includeHistory: true})) {
                let success = this.ingestItem(item);
                if (success) { numSuccess += 1; }
            }
        }
        return numSuccess;
    }

    sync(otherStore : IStore, opts? : SyncOpts) : SyncResults {
        // Sync with another Store.
        //   opts.direction: 'push', 'pull', or 'both'
        //   opts.existing: Sync existing values.  Default true.
        //   opts.live (not implemented yet): Continue streaming new changes forever
        // Return the number of items pushed and pulled.
        // This uses a simple and inefficient algorithm.  Fancier algorithm TBD.

        // don't sync with yourself
        if (otherStore === this) { return { numPushed: 0, numPulled: 0 }; }

        // don't sync across workspaces
        if (this.workspace !== otherStore.workspace) { return { numPushed: 0, numPulled: 0}; }

        // set default options
        let direction = opts?.direction || 'both';
        let existing = (opts?.existing !== undefined) ? opts?.existing : true;
        let live = (opts?.live !== undefined) ? opts?.live : false;

        let numPushed = 0;
        let numPulled = 0;
        if (direction === 'pull' || direction === 'both') {
            numPulled = this._syncFrom(otherStore, existing, live);
        }
        if (direction === 'push' || direction === 'both') {
            numPushed = otherStore._syncFrom(this, existing, live);
        }
        return { numPushed, numPulled };
    }

}