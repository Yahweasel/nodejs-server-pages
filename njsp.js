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

const fcgi = require("node-fastcgi");

const defaultConfig = {
    "port": "/tmp/nodejs-server-pages.sock",
    "ip": void 0,
    "db": "nodejs-server-pages.db"
};

/**
 * Threads ready to run server requests
 */
var readyThreads = [];

function createServer(config) {
    // Make sure we have a usable config
    if (typeof config === "undefined")
        config = {};
    for (var k in defaultConfig) {
        if (!(k in config))
            config[k] = defaultConfig[k];
    }

    // We'll need at least one thread
    spawnThread();

    // If we're listening to a UNIX-domain socket, delete any old one
    if (typeof config.port === "string") {
        try {
            fs.unlinkSync(config.port);
        } catch (ex) {}
    }

    // Then create the server
    return fcgi.createServer((req, res) => {
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
            d: config.db
        });

        // If we don't have any spare threads for future requests, expand
        if (readyThreads.length === 0)
            spawnThread();

    }).listen(config.port, config.ip);
}

/**
 * Spawn a thread.
 * @internal
 */
function spawnThread() {
    var c = cp.fork("./runner.js");
    c.res = null;

    c.on("message", (msg) => {
        if (!c.res) return;

        try {
            switch (msg.c) {
                case "h":
                    c.res.writeHead(msg.x, msg.h);
                    break;
                case "w":
                    c.res.write(msg.d);
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

if (require.main === module)
    createServer();

module.exports = {createServer};
