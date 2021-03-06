import fetch from 'isomorphic-fetch';
import {
    IStorage,
    WorkspaceAddress,
} from './util/types';
import {
    Emitter
} from './util/emitter';

let sleep = async (ms : number) : Promise<void> => {
    return new Promise((resolve, reject) => {
        setTimeout(resolve, ms);
    });
}

// sync states
//  idle      sync has not been attempted since page load
//  syncing   syncing is happening now
//  success   syncing succeeded
//  failure   syncing failed (probably couldn't connect to pub)
interface Pub {
    domain : string;
    syncState : 'idle' | 'syncing' | 'success' | 'failure';
    lastSync : number;
}
export interface SyncState {
    pubs : Pub[];
    // overall success is at least one pub success and any number of failures.
    // TODO: add a 'mixed' state
    syncState : 'idle' | 'syncing' | 'success' | 'failure';
    lastSync : number;
}

let ensureTrailingSlash = (url : string) : string =>
    // input is a URL with no path, like https://mypub.com or https://mypub.com/
    url.endsWith('/') ? url : url + '/';

//let normalizePubUrl = (url : string) : string =>  {
//    // input is a URL with no path, like https://mypub.com or https://mypub.com/
//    // output is the base URL for the API
//    if (!url.endsWith('/')) { url += '/'; }
//    url += 'earthstar-api/v1/';
//    return url;
//}

let logSyncer = (...args : any[]) => console.log('💚 syncer | ', ...args);
export class Syncer {
    storage : IStorage;
    onChange : Emitter<SyncState>;
    state : SyncState;
    constructor(store : IStorage) {
        this.storage = store;
        this.onChange = new Emitter<SyncState>();
        this.state = {
            pubs: [],
            syncState: 'idle',
            lastSync: 0,
        }
    }
    removePub(url : string) {
        url = ensureTrailingSlash(url);
        let numBefore = this.state.pubs.length;
        this.state.pubs = this.state.pubs.filter(pub => pub.domain !== url);
        let numAfter = this.state.pubs.length;
        if (numBefore !== numAfter) {
            this.onChange.send(this.state);
        }
    }
    addPub(domain : string) {
        domain = ensureTrailingSlash(domain);

        // don't allow adding the same pub twice
        if (this.state.pubs.filter(pub => pub.domain === domain).length > 0) { return; }

        this.state.pubs.push({
            domain: domain,
            syncState: 'idle',
            lastSync: 0,
        });
        this.onChange.send(this.state);
    }
    async sync() {
        logSyncer('starting');
        this.state.syncState = 'syncing';
        this.onChange.send(this.state);
        let numSuccessfulPubs = 0;
        let numFailedPubs = 0;

        for (let pub of this.state.pubs) {
            logSyncer('starting pub:', pub.domain);
            pub.syncState = 'syncing';
            this.onChange.send(this.state);

            let resultStats = await syncLocalAndHttp(this.storage, pub.domain);

            logSyncer('finished pub');
            logSyncer(JSON.stringify(resultStats, null, 2));
            if (resultStats.pull === null && resultStats.push === null) {
                pub.syncState = 'failure';
                numFailedPubs += 1;
            } else {
                pub.lastSync = Date.now();
                pub.syncState = 'success';
                numSuccessfulPubs += 1;
            }
            this.onChange.send(this.state);
        }

        // wait a moment so the user can keep track of what's happening
        await sleep(150);

        logSyncer('finished all pubs');
        this.state.lastSync = Date.now();
        if (numSuccessfulPubs > 0) { this.state.syncState = 'success'; }
        else if (numFailedPubs > 0) { this.state.syncState = 'failure'; }
        else { this.state.syncState = 'idle'; }  // apparently we have no pubs at all
        this.onChange.send(this.state);
    }
}

let urlGetDocuments = (domain : string, workspace : WorkspaceAddress) =>
    // domain should already end in a slash.
    // output is like https://mypub.com/earthstar-api/v1/workspace/gardening.xxxxxxxx/documents
    // note we remove the double slash from workspace
    `${domain}earthstar-api/v1/workspace/${workspace.slice(2)}/documents`;
let urlPostDocuments = urlGetDocuments;

let logSyncAlg = (...args : any[]) => console.log('  🌲  sync algorithm | ', ...args);

export let syncLocalAndHttp = async (storage : IStorage, domain : string) => {
    logSyncAlg('existing database workspace:', storage.workspace);
    let resultStats : any = {
        pull: null,
        push: null,
    }
    domain = ensureTrailingSlash(domain);

    // pull from server
    // this can 404 the first time, because the server only creates workspaces
    // when we push them
    logSyncAlg('pulling from ' + domain);
    let resp : any;
    try {
        resp = await fetch(urlGetDocuments(domain, storage.workspace));
    } catch (e) {
        console.error('ERROR: could not connect to server');
        console.error(e.toString());
        return resultStats;
    }
    resultStats.pull = {
        numIngested: 0,
        numIgnored: 0,
        numTotal: 0,
    };
    if (resp.status === 404) {
        logSyncAlg('    server 404: server does not know about this workspace yet');
    } else {
        let docs = await resp.json();
        resultStats.pull.numTotal = docs.length;
        for (let doc of docs) {
            if (storage.ingestDocument(doc)) { resultStats.pull.numIngested += 1; }
            else { resultStats.pull.numIgnored += 1; }
        }
        logSyncAlg(JSON.stringify(resultStats.pull, null, 2));
    }

    // push to server
    logSyncAlg('pushing to ' + domain);
    let resp2 : any;
    try {
        resp2 = await fetch(urlPostDocuments(domain, storage.workspace), {
            method: 'post',
            body:    JSON.stringify(storage.documents({ includeHistory: true })),
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (e) {
        console.error('ERROR: could not connect to server');
        console.error(e.toString());
        return resultStats;
    }
    if (resp2.status === 404) {
        logSyncAlg('    server 404: server is not accepting new workspaces');
    } else if (resp2.status === 403) {
        logSyncAlg('    server 403: server is in readonly mode');
    } else {
        resultStats.pushStats = await resp2.json();
        logSyncAlg(JSON.stringify(resultStats.pushStats, null, 2));
    }

    return resultStats;
};
