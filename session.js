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

/* Support for session variable storage, using SQLite3 */

const util = require("util");

const cookie = require("cookie");
const sqlite3 = require("sqlite3");

function up(obj, meth) {
    return util.promisify(obj[meth].bind(obj));
}

async function rollback(db) {
    try {
        await up(db, "run")("ROLLBACK;");
    } catch (ex) {}
}

/**
 * The session object. Handles all cookie-to-session conversion.
 */
function Session(db, request, response) {
    this.db = new sqlite3.Database(db);
    this.run = up(this.db, "run");
    this.dbGet = up(this.db, "get");
    this.request = request;
    this.response = response;
    this.inited = false;
}

/**
 * Initialize a session. Must be called before headers are sent out.
 */
Session.prototype.init = async function(config) {
    if (this.inited)
        return;
    let sid = null;
    this.inited = true;

    if (typeof config === "undefined")
        config = {};

    this.expiry = config.expiry = (config.expiry || 60*60*24*30*6);

    // Make sure the database is real
    await this.run("PRAGMA journal_mode=WAL;");
    await this.run("CREATE TABLE IF NOT EXISTS session (sid TEXT, key TEXT, value TEXT, expires TEXT);");
    await this.run("CREATE INDEX IF NOT EXISTS session_sid ON session (sid, key);");
    await this.run("CREATE INDEX IF NOT EXISTS session_exp ON session (expires);");

    // Try to get the existing session ID
    if ("cookie" in this.request.headers) {
        //  Check if our cookie is already there
        const cookies = cookie.parse(this.request.headers.cookie);
        if ("NJSPSESSID" in cookies) {
            sid = cookies.NJSPSESSID;

            // Check if it's actually valid
            row = await this.dbGet("SELECT * FROM session WHERE sid=@SID;", {"@SID": sid});
            if (!row)
                sid = null;
        }
    }

    // If we don't have a response to set a cookie, we can't make a new session
    if (!this.response)
        return;

    // Create a new session ID
    if (!sid) {
        while (true) {
            let row = null;
            function part() { return (Math.random()).toString(36).slice(2); }
            sid = part() + part() + part();

            try {
                await this.run("BEGIN TRANSACTION;");
                row = await this.dbGet("SELECT * FROM session WHERE sid=@SID;", {"@SID": sid});
                if (!row) {
                    await this.run("INSERT INTO session VALUES (@SID, @KEY, @VALUE, datetime('now','" + config.expiry + " seconds'));", {
                        "@SID": sid,
                        "@KEY": "njspsessid",
                        "@VALUE": JSON.stringify(sid)
                    });
                }
                await this.run("COMMIT;");

                if (!row)
                    break;

            } catch (ex) {
                await rollback(this.db);
            }
        }
    }

    // Put the session ID in a cookie
    const cook = cookie.serialize("NJSPSESSID", sid, {
        maxAge: config.expiry,
        path: (config.path || "/")
    });
    this.response.setHeader("set-cookie", cook);

    this.sid = sid;

    // Do cleanup so long as we're here
    await this.cleanup();
}

Session.prototype.get = async function(key) {
    if (!this.sid)
        return false;
    const row = await this.dbGet("SELECT value FROM session WHERE sid=@SID AND key=@KEY;", {
        "@SID": this.sid,
        "@KEY": key
    });
    if (!row)
        return null;
    return JSON.parse(row.value);
}

Session.prototype.getAll = async function() {
    if (!this.sid)
        return null;
    const rows = await up(this.db, "all")("SELECT * FROM session WHERE sid=@SID;", {"@SID": this.sid});
    const ret = {};
    for (const row of rows) {
        ret[row.key] = JSON.parse(row.value);
    }
    return ret;
}

Session.prototype.set = async function(key, value) {
    if (!this.sid)
        return;
    while (true) {
        try {
            await this.run("BEGIN TRANSACTION;");
            await this.run("DELETE FROM session WHERE sid=@SID AND key=@KEY;", {
                "@SID": this.sid,
                "@KEY": key
            });
            await this.run("INSERT INTO session VALUES (@SID, @KEY, @VALUE, datetime('now','" + this.expiry + " seconds'));", {
                "@SID": this.sid,
                "@KEY": key,
                "@VALUE": JSON.stringify(value)
            });
            await this.run("COMMIT;");
            break;
        } catch (ex) {
            await rollback(this.db);
        }
    }
}

Session.prototype.delete = async function(key) {
    if (!this.sid)
        return;
    await this.run("DELETE FROM session WHERE sid=@SID AND key=@KEY;", {
        "@SID": this.sid,
        "@KEY": key
    });
}

Session.prototype.cleanup = async function() {
    if (!this.sid)
        return;
    await this.run("DELETE FROM session WHERE expires<=datetime('now');");
}

Session.prototype.close = async function() {
    await up(this.db, "close")();
}

module.exports = {Session};
