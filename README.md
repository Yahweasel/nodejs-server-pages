NodeJS-Server-Pages is a system for using Node.JS code on a web server, using
FastCGI. Like PHP, web pages are written in a templated style, with server-side
JavaScript code embedded into HTML (or anything else).

For instance, the following page displays the current time, generated on the
server:

    <html>
        <body>
            The current time is <?JS write(new Date().toDateString()); ?>.
        </body>
    </html>

So-called "echo tags" are also supported, e.g.:

    <html>
        <body>
            The current time is <?JS= new Date().toDateString() ?>
        </body>
    </html>

You can also abbreviate `<?JS` as `<?`, as in PHP.

Various concepts in NJSP are inspired by CGI-Node, but NJSP's design makes for
much faster, more responsive web sites. No CGI-Node code was used (or even
looked at) in the design of NJSP.


# Installing NodeJS-Server-Pages

This repository can be used directly (run njsp.js), or used as a module. Use
the `createServer` method when using NJSP as a module:

    const njsp = require("nodejs-server-pages");
    njsp.createServer({port: 3000, ip: "127.0.0.1"});

The configuration parameter to `createServer` takes three options: `port`, `ip`
and `db`. NJSP presents a FastCGI server on the given IP and port, or, if
`port` is a string, at the given Unix domain socket. The default is the Unix
socket `/tmp/nodejs-server-pages.sock`. The `db` option is the path to an
SQLite3 database, which NJSP will create if it doesn't exist, in which to store
session data. The default is `nodejs-server-pages.db`. To use all default
arguments, it's sufficient to pass no config argument at all, so the simplest
NJSP client requires nothing more than:

    require("nodejs-server-pages").createServer()

NJSP is a standard FastCGI server, so then you must configure your web server
to use it. In NGINX, for example:

    location ~ \.jss$ {
        fastcgi_pass unix:/tmp/nodejs-server-pages.sock;
        include fastcgi_params;
    }

You may also want to make index.jss a default index page.

If it's not perfectly clear, note that NJSP pages will be run *with the
permissions of whichever user runs NJSP itself*. Do *not* install or use NJSP
if you need greater control of who executes code than this. I may eventually
consider a version of NJSP that handles user permissions in a useful way.


# Using NodeJS-Server-Pages

Simply create pages named with .jss (or whatever extension you used in the
server configuration), and embed JavaScript code in `<?JS ... ?>`, or
JavaScript expressions in `<?JS= ... ?>`.

A NJSP page is compiled into a JavaScript `async function`, and the page is
considered complete after awaiting its result. As a consequence, you must be
careful to use `await` within your NJSP code at any points where the sending of
the web page to the client needs to wait for some processing. You may find
Node's `util.promisify` extremely helpful (essentially mandatory) for this.

NJSP pages may use all the features of Node.JS, including `require`. Modules
will be searched for in the NJSP installation directory, not the web server's
document root.

NJSP exposes a number of variables and functions for use in web pages:


## request

`request` represents the HTTP request, though it is strictly static.

`request.url` is the full URL of the request.

`request.headers` maps headers in the request to their values.

`request.query` maps query variables to their values.


## response

`response` represents the HTTP response, and has several of the methods
available in Node's HTTP response type. It does not directly reflect Nodes'
HTTP response type or node-fastcgi's response type, however.

`response.write(data)` writes `data` to the web client, converting to a string
if necessary. This function is aliased as `write` for brevity.

`response.setHeader(name, value)` sets a header with the given name to the
given value.

`response.writeHead(code, headers)` writes the header, with the given status
code and headers, which are added to any headers set by `setHeader`. Only the
first call to `writeHead` has an effect, and `writeHead` will be called
automatically when `write` is called, or when the non-JavaScript part of a NJSP
file writes any data. Thus, it's only necessary to use `writeHead` in special
circumstances. This function is aliased as `writeHead` for brevity.

`response.end()` ends the response. This is unlikely to be useful in most
circumstances, but could be used to allow the server to continue doing some
processing even after the page is complete.


## params

`params` maps FastCGI parameters to their values, such as `params.SCRIPT_NAME`
and `params.DOCUMENT_ROOT`.


## session

You may store session variables per user, keyed by a cookie stored in the
user's browser, on the server, accessible through `session`. All `session`
functions are asynchronous, and so must be `await`ed, or otherwise have their
promise handled. Asynchronous functions will be written with `await` here to
make that clear.

`await session.init()` initializes the session state for this session. Note
that this *must* be called *before* writing the header; unlike PHP, sessions
are not created automatically.

`await session.get(key)` gets the value stored in the name `key` for this
session. Returns `null` if there is no such key-value pair.

`await session.getAll()` gets a map of all keys to all values stored for this
session.

`await session.set(key, value)` adds or replaces the key-value pair of `key`
and `value` to the session data for this session.

`await session.delete(key)` deletes any value bound to the key `key` for this
session.


## include and compile

`await include(filename)` includes the NJSP file named by `filename`, searched
in the directory of the current file. Note that you can include normal
JavaScript files with `require` instead; this is only for NJSP files.

`compile(filename)` parses and compiles `filename` into an asynchronous
function in the same way as `include`, but does not run it. Note, however, that
these functions take a map of all these globals as an argument, so the plain
function is probably largely useless.


# Technical details

NJSP operates a threadpool (really, a process pool) of Node.JS processes which
handle individual requests. When a request is made, one of these processes is
chosen, and it runs the requested page.

The page is compiled into an `async function`, simply by replacing the text
components with calls to `write`, and this is compiled using `AsyncFunction`.

The handler processes cache pages they've been requested to load, so that
reused pages are handled extremely quickly, requiring no further parsing or
compilation, and benefiting from JIT.

When the `async function`'s promise resolves, the response is closed, and more
requests are allowed. Technically, there's nothing to stop the page from having
events left over, and these may interfere with future pages. It's best simply
to avoid this.


# Why NodeJS-Server-Pages?

## Why NodeJS-Server-Pages instead of (other JS solution) x?

To be honest, I haven't found `x`. I'm surprised not to find many alternatives
for this PHP-style templating. Perhaps because of the problem with asynchrony;
we needed Node to support `async function`s before this would've been useful.
If you know of one, please tell me; I don't want to step on any feet!

The only alternative I'm aware of is CGI-Node, but that's a non-starter for a
number of reasons. As the name suggests, it's CGI, so it spins up a new Node
process for every page view. For a language like Perl, which was the common use
case of CGI back in the day, this startup time is negligible. But for Node,
startup time can be significant. Further, that's chewing through a lot of
memory, and making zero use of the JIT.

Worse yet, CGI-Node has no real support for asynchrony, which is, at best,
troublesome for Node.JS.

In terms of JS solutions that allow you to build web pages but not with
PHP-style embedded-code templates... well, it's a matter of taste. I don't like
PHP very much, but I think that style was an extremely good choice. It's a very
elegant way of expressing code in the context of filling in a web page. There
are many tasks for which that makes no sense, but there are also many tasks for
which it makes perfect sense, and NJSP is designed for those.


## Why NodeJS-Server-Pages instead of PHP?

https://eev.ee/blog/2012/04/09/php-a-fractal-of-bad-design/


# Limitations and future

I made NJSP because I needed it. It's probably not going to change very much,
simply because there aren't a lot of moving parts, and so not a lot that would
need to change. All the heavy lifting is done by Node.JS itself.

The most pressing limitation right now is that I haven't implemented HTTP POST
at all yet. I have no reason not to have done so, I just haven't gotten around
to it. It will certainly be done if I continue using NJSP.

NJSP's server model presents a bottleneck, as all data has to pass through the
main thread on its way to or back from one of the worker threads. That being
said, that's the lightest load, and this model is perfectly common. If that's a
major bottleneck, probably you would need to have created more redundancy at an
earlier stage, e.g. the web server itself, beforehand.

NJSP's cache makes the *second* load of any page fast, but the *first* load is
still pretty slow. It would be nice to persist the cache in some way, so that
new worker threads and new runs of NJSP would know what pages to cache.
However, if the cache was persistent, cache invalidation would be absolutely
mandatory, and who wants to bother with that?
