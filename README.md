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

In addition, a "no-direct" tag is supported, for pages which must be included
from other pages (e.g. headers and footers):

    <?JS! /* this must be included from elsewhere! */ ?>
    <div id="header">
        Header!
    </div>

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

`request.bodyRaw` is the *raw* (Buffer) body sent by the client on POST
requests. You can use its presence to determine if a POST request was made,
even if the body doesn't parse.

`request.body` is the parsed client body, using whichever content-type the
client specified. Currently supported are application/json,
application/x-www-form-urlencoded, multipart/form-data, and text/plain.

`request.bodyException` is the exception thrown while attempting to parse the
body if it failed. Either this or `request.body` will be present if the type is
supported.

`request.files` is, in the case of multipart/form-data, the array of file data
uploaded. Each entry is an object with a filename, name, and data field, where
the filename is the client-specified filename uploaded, the name is the
form-specified name of the file field, and data is a Node buffer with the
content of the file. If the content type is not multipart/form-data, this field
does not exist.


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

`response.compress(request)` will enable compression (gzip or brotli) based on
what the request supports. To *disable* compression, which may be necessary if
you need data to flush to the client immediately, use
`response.compress(null)`. This must be done before `writeHead`, and is done
automatically (compression is on by default).

`response.setTimeLimit(limit)` sets the time limit, in milliseconds, starting
from the point when the function is called. There is no function to disable the
time limit entirely.


## params

`params` maps FastCGI parameters to their values, such as `params.SCRIPT_NAME`
and `params.DOCUMENT_ROOT`.


## session

You may store session variables per user, keyed by a cookie stored in the
user's browser, on the server, accessible through `session`. All `session`
functions are asynchronous, and so must be `await`ed, or otherwise have their
promise handled. Asynchronous functions will be written with `await` here to
make that clear.

`await session.init(config)` initializes the session state for this session.
Note that this *must* be called *before* writing the header; unlike PHP,
sessions are not created automatically. The optional `config` parameter is an
object with configuration options. `config.expiry` sets the maximum age of
session variables for this session, in seconds, defaulting to 6 months.
`config.path` sets the path over which this session's cookie should apply,
defaulting to /.

`await session.get(key)` gets the value stored in the name `key` for this
session. Returns `null` if there is no such key-value pair.

`await session.getAll()` gets a map of all keys to all values stored for this
session.

`await session.set(key, value)` adds or replaces the key-value pair of `key`
and `value` to the session data for this session.

`await session.delete(key)` deletes any value bound to the key `key` for this
session.


## include, compile, and module

`await include(filename, [args])` includes the NJSP file named by `filename`,
searched in the directory of the current file. Note that you can include normal
JavaScript files with `require` instead; this is only for NJSP files. This
behaves like `require`, insofar as it returns (a Promise which resolves to) an
object, set by `module.exports` in the NJSP file referenced. Optional further
arguments may be provided to `include`, and if provided, will be available in
the included code in `arguments[1]` and further.

`compile(filename)` parses and compiles `filename` into an asynchronous
function in the same way as `include`, but does not run it. Note, however, that
these functions take a map of all these globals as an argument, so the plain
function is probably largely useless.

`module.exports` will be exported to whoever includes this NJSP page, as with
`require`. Otherwise, `module` is nothing like Node's `module`.


# Why NodeJS-Server-Pages?

## Why NodeJS-Server-Pages instead of (other JS solution) x?

To be honest, I haven't found a satisfying `x`. I'm surprised not to find many
alternatives for this PHP-style templating. Perhaps because of the problem with
asynchrony; we needed Node to support `async function`s before this would've
been useful.  If you know of one, please tell me; I don't want to step on any
feet!

### CGI-Node

CGI-Node is a non-starter for a number of reasons. As the name suggests, it's
CGI, so it spins up a new Node process for every page view. For a language like
Perl, which was the common use case of CGI back in the day, this startup time
is negligible. But for Node, startup time can be significant. Further, that's
chewing through a lot of memory, and making zero use of the JIT.

Worse yet, CGI-Node has no real support for asynchrony, which is, at best,
troublesome for Node.JS.

### EJS

( https://ejs.co )

EJS is half the solution: It does the templating, but isn't easily built into
an existing web-server infrastructure. I could've made NJSP use EJS for its
templating (and might do so in the future), but that's not the interesting part
to me. I'm also dissatisfied with how EJS handles the variables of the compiled
functions. `with` is never the right option, and since they're compiling
anyway, there's no compelling reason not to compile them in as plain ol'
`var`s.

Also, EJS compiles to functions which *return* strings, rather than sending
strings via some response, which is exactly not what PHP or NJSP does. NJSP
allows you to send partial output, then do some processing, then send the rest.
Whether this is useful is debatable, but it is a major difference.

Ultimately, the part of NJSP that EJS solves is actually pretty small, and NSJP
solves it in a way that's better suited for its use case.


### Express, etc

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

To be quite precise, the example from the beginning of this README resolves to
this code:

    var request = module.request;
    var response = module.response;
    var params = module.params;
    var writeHead = module.writeHead;
    var write = module.write;
    var session = module.session;
    var compileAbsolute = module.compileAbsolute;
    var require = module.require;
    function compile(name) {
    name = (name[0]==='/') ? name : ("/var/www/html/"+name);
    return module.compileAbsolute(name);
    }
    async function include(name) {
    var sm = {request,response,params,writeHead,write,session,compileAbsolute,require,exports:{}};
    await (compile(name)(sm));
    return sm.exports;
    }
    write("<html>\n    <body>\n        The current time is ");
    write(new Date().toDateString()); write(".\n    </body>\n</html>\n");
