#!/usr/bin/env node
/*
 * Copyright (c) 2020-2022 Yahweasel
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY
 * SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
 * OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN
 * CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

/* The main entry point for NJSP. Just takes requests and sends them off to
 * runner threads. */

const cp = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const util = require("util");

const fcgi = require("node-fastcgi");
const sqlite3 = require("sqlite3");
const ws = require("ws");

const defaultConfig = {
    "port": "/tmp/nodejs-server-pages.sock",
    "ip": void 0,
    "db": "nodejs-server-pages.db"
};

const defaultWSConfig = {
    "port": "/tmp/nodejs-server-pages-ws.sock",
    "ip": void 0,
    "db": "nodejs-server-pages.db"
};

// The SQL to set up our error database
const errDBSQL = [
    "PRAGMA journal_mode=WAL;",
    `CREATE TABLE IF NOT EXISTS errors (time STRING, page STRING, file STRING,
        error STRING);`,
    "CREATE INDEX IF NOT EXISTS errors_time ON errors (time);"
];

// Create a NODE_PATH variable so that the runner can use the *main* modules
const childNodePath = (function() {
    let nodePath = ((process.env.NODE_PATH + ":") || "");
    nodePath += (require.main || module).paths.join(":");
    return nodePath;
})();

// Add that to the environment
const childEnv = (function() {
    let env = {};
    for (const v in process.env)
        env[v] = process.env[v];
    env.NODE_PATH = childNodePath;
    return env;
})();

/**
 * Threads ready to run server requests
 */
let readyThreads = [];

/**
 * Threads currently running server requests
 */
let busyThreads = 0;

/**
 * Threads handling ws requests
 */
let wsThreads = {};

/**
 * Create our FastCGI server
 */
function createServer(config) {
    config = config || {};

    // Prepare the DB
    let error = null;
    if (config.errDB) {
        const errDB = new sqlite3.Database(config.errDB);
        const errP = (async function() {
            for (const sql of errDBSQL)
                await new Promise(res => errDB.run(sql, res));
        })();

        error = async function(page, file, err) {
            await errP;
            errDB.run(
                `
                INSERT INTO errors VALUES
                    (datetime('now'), @PAGE, @FILE, @ERROR);
                `, {
                "@PAGE": page,
                "@FILE": file,
                "@ERROR": err
            });
        };


    } else {
        error = function(page, file, err) {
            console.error(`${file} (${page}):\n${err}\n`);
        };

    }

    // We'll need at least one thread
    spawnThread(error);

    // If we're listening to a UNIX-domain socket, delete any old one
    let port = config.port || defaultConfig.port;
    if (typeof port === "string") {
        try {
            fs.unlinkSync(port);
        } catch (ex) {}
    }

    // Then create the server
    return fcgi.createServer((req, res) => {
        function go(body) {
            // Send this request to a runner thread
            if (readyThreads.length === 0)
                spawnThread(error);
            const thr = readyThreads.shift();
            busyThreads++;

            thr.res = res;
            thr.send({
                c: "r",
                r: {
                    url: req.url,
                    headers: req.headers,
                    query: req.socket.params.QUERY_STRING
                },
                p: req.socket.params,
                b: body,
                d: config.db || defaultConfig.db
            });

            // If we don't have any spare threads for future requests, expand
            if (readyThreads.length === 0)
                spawnThread(error);
        }

        if (req.method === "GET") {
            go();

        } else if (req.method === "POST") {
            let body = new Buffer(0);
            req.on("data", (chunk) => {
                body = Buffer.concat([body, chunk]);
            });
            req.on("end", () => {
                go(body.toString("binary"));
            });

        } else {
            res.writeHead(501);
            res.end();

        }

    }).listen(port, config.ip || defaultConfig.ip);
}

/**
 * Spawn a thread.
 * @internal
 * @param error  Callback for when errors occur.
 */
function spawnThread(error) {
    let c = cp.fork(__dirname + "/runner.js", {env: childEnv});
    c.res = null;

    c.on("message", (msg) => {
        if (!c.res) return;

        try {
            switch (msg.c) {
                case "h":
                    c.res.writeHead(msg.x, msg.h);
                    break;
                case "w":
                    if (msg.d)
                        c.res.write(msg.d);
                    else
                        c.res.write(Buffer.from(msg.x, "binary"));
                    break;
                case "x":
                    if (error)
                        error(msg.p, msg.f, msg.e);
                    break;
                case "e":
                    c.res.end();
                    c.res = null;
                    readyThreads.push(c);
                    busyThreads--;
                    unspawnThreads();
                    break;
            }
        } catch (ex) {
            console.error(ex.stack+"");
        }
    });

    c.on("exit", () => {
        // Make sure we don't consider a dead thread to be ready or busy
        let i = readyThreads.indexOf(c);
        if (i === -1)
            busyThreads--;
        else
            readyThreads.splice(i, 1);

        // And end the response if needed
        if (c.res) {
            c.res.end();
            c.res = null;
        }
    });

    readyThreads.push(c);
}

/**
 * Unspawn if we have excess threads
 * @internal
 */
function unspawnThreads() {
    function vmSize(pid) {
        try {
            let status = fs.readFileSync(`/proc/${pid}/status`).split("\n");
            for (let s of status) {
                let parts = s.split(":");
                if (parts[0] === "VmSize")
                    return parseInt(parts[1]);
            }
        } catch (ex) {
            return 0;
        }
    }

    let bt = busyThreads;
    while (readyThreads.length > bt + 2) {
        // Choose the process with the greatest VM size
        let maxIdx = 0;
        let max = 0;
        for (let i = 0; i < readyThreads.length; i++) {
            let pid = readyThreads[i].pid;
            let sz = vmSize(pid);
            if (sz > max) {
                maxIdx = i;
                max = sz;
            }
        }

        // Kill it
        readyThreads[maxIdx].send({c: "t"});
        readyThreads.splice(maxIdx, 1);
        busyThreads++;
    }
}

/**
 * Create our HTTP/ws server
 */
function createWSServer(config) {
    config = config || {};

    // If we're listening to a UNIX-domain socket, delete any old one
    const port = config.port || defaultWSConfig.port;
    if (typeof port === "string") {
        try {
            fs.unlinkSync(port);
        } catch (ex) {}
    }

    // Create the server
    const hs = http.createServer();

    // Listen in the right place
    hs.listen(port, config.ip || defaultWSConfig.ip);

    // And listen for upgrade requests
    hs.on("upgrade", (req, sock) => {
        // Find the root
        const host = "host:" + req.headers.host;
        let root;
        if (host in config.root)
            root = config.root[host];
        else
            root = config.root["default"];

        // Find the file
        let fname = req.url.replace(/\?.*/, "");
        try {
            fname = decodeURIComponent(fname);
        } catch (ex) {
            return sock.destroy();
        }
        fname = root + path.normalize("/" + fname) + ".js";

        // Get the stats
        let sbuf = null;
        try {
            sbuf = fs.statSync(fname);
        } catch (ex) {}

        if (!sbuf) {
            // Invalid file
            return sock.destroy();
        }

        // Check
        let wsThread = wsThreads[fname];
        if (wsThread && wsThread.mtime < sbuf.mtimeMs) {
            // Thread is out of date
            wsThread.c.disconnect();
            wsThread = null;
        }

        // Maybe make a new thread
        if (!wsThread) {
            wsThreads[fname] = wsThread = {
                mtime: sbuf.mtimeMs,
                c: cp.fork(__dirname + "/wsrunner.js", {env: childEnv, detached: true, stdio: "ignore"})
            };
            wsThread.c.on("exit", () => {
                if (wsThreads[fname] === wsThread)
                    delete wsThreads[fname];
            });
            wsThread.c.send({c: "l", f: fname, x: config.errDB || null});
        }

        // Run this socket
        wsThread.c.send({
            c: "r",
            r: {
                url: req.url,
                method: req.method,
                headers: req.headers
            },
            d: config.db || defaultWSConfig.db
        }, sock);
    });

    hs.on("request", (req, res) => {
        res.writeHead(426);
        res.write("426: Upgrade Required");
        res.end();
    });
}

if (require.main === module)
    createServer();

module.exports = {createServer, createWSServer};
