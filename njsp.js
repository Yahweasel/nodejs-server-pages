#!/usr/bin/env node
/*
 * Copyright (c) 2020 Yahweasel
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

const fcgi = require("node-fastcgi");
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

// Create a NODE_PATH variable so that the runner can use the *main* modules
const childNodePath = (function() {
    var nodePath = ((process.env.NODE_PATH + ":") || "");
    nodePath += require.main.paths.join(":");
    return nodePath;
})();

// Add that to the environment
const childEnv = (function() {
    var env = {};
    for (var v in process.env)
        env[v] = process.env[v];
    env.NODE_PATH = childNodePath;
    return env;
})();

/**
 * Threads ready to run server requests
 */
var readyThreads = [];
var wsThreads = {};

/**
 * Create our FastCGI server
 */
function createServer(config) {
    config = config || {};

    // We'll need at least one thread
    spawnThread();

    // If we're listening to a UNIX-domain socket, delete any old one
    var port = config.port || defaultConfig.port;
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
                spawnThread();
            var thr = readyThreads.shift();

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
                spawnThread();
        }

        if (req.method === "GET") {
            go();

        } else if (req.method === "POST") {
            var body = new Buffer(0);
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
 */
function spawnThread() {
    var c = cp.fork(__dirname + "/runner.js", {env: childEnv});
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
                case "e":
                    c.res.end();
                    c.res = null;
                    readyThreads.push(c);
                    break;
            }
        } catch (ex) {
            console.error(ex.stack+"");
        }
    });

    c.on("exit", () => {
        // Make sure we don't consider a dead thread to be ready
        var i = readyThreads.indexOf(c);
        if (i !== -1)
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
 * Create our HTTP/ws server
 */
function createWSServer(config) {
    config = config || {};

    // If we're listening to a UNIX-domain socket, delete any old one
    var port = config.port || defaultWSConfig.port;
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
        var host = "host:" + req.headers.host;
        var root;
        if (host in config.root)
            root = config.root[host];
        else
            root = config.root["default"];

        // Find the file
        var fname = req.url.replace(/\?.*/, "");
        try {
            fname = decodeURIComponent(fname);
        } catch (ex) {
            return sock.destroy();
        }
        fname = root + path.normalize("/" + fname) + ".js";
        console.error(fname);

        // Get the stats
        var sbuf = null;
        try {
            sbuf = fs.statSync(fname);
        } catch (ex) {}

        if (!sbuf) {
            // Invalid file
            return sock.destroy();
        }

        // Check
        var wsThread = wsThreads[fname];
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
            wsThread.c.send({c: "l", f: fname});
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
