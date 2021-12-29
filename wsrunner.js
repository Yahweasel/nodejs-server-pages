/*
 * Copyright (c) 2020, 2021 Yahweasel
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

const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const fs = require("fs");
const path = require("path");
const querystring = require("querystring");

const sqlite3 = require("sqlite3");
const ws = require("ws");

const session = require("./session.js");

/**
 * Global no-server websocket server
 */
const wss = new ws.Server({noServer: true});

/**
 * Our compiled function
 */
let func;

/**
 * Our child module
 */
let cmodule;

/**
 * Error database schema (FIXME: duplication).
 */
const errDBSQL = [
    "PRAGMA journal_mode=WAL;",
    `CREATE TABLE IF NOT EXISTS errors (time STRING, page STRING, file STRING,
        error STRING);`,
    "CREATE INDEX IF NOT EXISTS errors_time ON errors (time);"
];

/**
 * Function to call when an error occurs.
 */
let error = null;

/**
 * Compile the named file into an AsyncFunction
 */
function compile(fname, errDBF) {
    let realName = fname;
    try {
        realName = fs.realpathSync(fname);
    } catch (ex) {}

    // Prepare for errors
    if (errDBF) {
        const errDB = new sqlite3.Database(errDBF);
        const errP = (async function() {
            for (const sql of errDBSQL)
                await new Promise(res => errDB.run(sql, res));
        })();

        error = async function(err) {
            await errP;
            errDB.run(
                `
                INSERT INTO errors VALUES
                    (datetime('now'), '', @FILE, @ERROR);
                `, {
                "@FILE": fname,
                "@ERROR": err
            });
        };
    }

    // Make require accessible directly
    let header = "";
    for (const global of ["require", "__dirname", "__filename"])
        header += "var " + global + " = module." + global + ";\n";

    // Compile
    const fcont = fs.readFileSync(fname, "utf8");
    try {
        func = new AsyncFunction("request", "sock", "session", "module", header + fcont);
    } catch (ex) {
        if (error)
            error(ex + "\n" + ex.stack);
        func = async function(req, sock) { sock.close(); };
    }

    // And make the "module"
    cmodule = {
        require: require.main.require,
        __dirname: path.dirname(realName),
        __filename: realName
    };
}

/**
 * The main entry point. Respond to a socket.
 */
function run(db, req, sock) {
    // Create a session
    const s = new session.Session(db, req, {setHeader: ()=>{}});

    // Parse its query string
    req.query = querystring.parse(req.url.replace(/^[^\?]*(\?|$)/, ""));

    // Run it
    wss.handleUpgrade(req, sock, [], (ws) => {
        ws.on("close", finish);
        func(req, ws, s, cmodule).catch(ex => {
            if (error)
                error(ex + "\n" + ex.stack);
            ws.close();
        });
    });

    // Close when we're done
    function finish() {
        s.close(); // No await, just let it finish in the background
    }
}

// Handle messages from the server
process.on("message", (msg, sock) => {
    switch (msg.c) {
        case "l":
            compile(msg.f, msg.x);
            break;

        case "r":
            run(msg.d, msg.r, sock);
            break;

        case "t":
            // Terminate
            process.exit(0);
            break;
    }
});
