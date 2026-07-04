---
authors: omscse
---

# Comparing Node.js concurrency models

Node.js runs your JavaScript on a single thread, driven by the [event loop](/learn/asynchronous-work/event-loop-timers-and-nexttick). That model is great for I/O-bound work — reading files, querying a database, handling HTTP requests — because Node hands off the waiting to the operating system and keeps the thread free.

It's a poor fit for two other situations, though:

- **CPU-bound work** (image resizing, hashing, parsing huge payloads) ties up the single thread and makes your whole application unresponsive while it runs.
- **Scaling across CPU cores** — a single Node.js process only ever uses one core for its JavaScript, no matter how many cores the machine has.

Node.js ships three built-in modules to address this: [`node:child_process`](https://nodejs.org/api/child_process.html), [`node:worker_threads`](https://nodejs.org/api/worker_threads.html), and [`node:cluster`](https://nodejs.org/api/cluster.html). They solve overlapping problems in different ways, which is why it's easy to reach for the wrong one. This guide compares them side by side and walks through when to use each.

## The three options at a glance

|                  | Runs               | Memory    | Talks via                | Best for                      |
| :--------------- | :----------------- | :-------- | :----------------------- | :---------------------------- |
| `child_process`  | Separate process   | Isolated  | stdio, or IPC (`fork()`) | Running external programs     |
| `worker_threads` | Separate thread    | Shareable | `postMessage()`          | CPU-bound JS work             |
| `cluster`        | Multiple processes | Isolated  | IPC                      | Scaling a server across cores |

A useful way to tell them apart: `cluster` is built on top of `child_process` specifically to solve the "scale a server across cores" problem, while `worker_threads` exists to solve the "run CPU-heavy code without blocking" problem without paying the cost of a whole new process.

## Child Process

Use `child_process` when you need to run another program — a shell command, a binary, a script in another language — from Node.js, or when you want a fully isolated Node.js process that you drive over stdio/IPC.

### `spawn`, `exec`, `execFile`, and `fork`

| Method       | Description                                  | Use case                       |
| :----------- | :------------------------------------------- | :----------------------------- |
| `spawn()`    | Streams stdout/stderr                        | Long-running, large output     |
| `exec()`     | Buffers full output via a shell              | Short commands, small output   |
| `execFile()` | Like `exec()`, no shell                      | Running a known binary safely  |
| `fork()`     | `spawn()` + built-in IPC for Node.js modules | Parent/child Node.js messaging |

`exec()` buffers the child's entire stdout/stderr in memory and only calls back once the process exits, with the result capped at 1 MiB (`maxBuffer`) by default — trying to capture a large or unbounded output this way will truncate it and terminate the child. `execFile()` avoids spawning a shell entirely, which also sidesteps shell-injection risks when part of the command comes from user input.

### Example: streaming a long-running command with `spawn()`

```cjs
const { spawn } = require('node:child_process');

const child = spawn('ffmpeg', ['-i', 'input.mp4', 'output.mp3']);

child.stdout.on('data', data => console.log(`stdout: ${data}`));
child.stderr.on('data', data => console.error(`stderr: ${data}`));
child.on('close', code => console.log(`Process exited with code ${code}`));
```

```mjs
import { spawn } from 'node:child_process';

const child = spawn('ffmpeg', ['-i', 'input.mp4', 'output.mp3']);

child.stdout.on('data', data => console.log(`stdout: ${data}`));
child.stderr.on('data', data => console.error(`stderr: ${data}`));
child.on('close', code => console.log(`Process exited with code ${code}`));
```

`spawn()` streams output as it's produced instead of buffering it, which is why it's the right choice for anything long-running or with unpredictable output size.

### Example: talking to another Node.js process with `fork()`

```cjs displayName="parent.js"
const { fork } = require('node:child_process');

const child = fork('./child.js');
child.send({ task: 'start', data: 42 });
child.on('message', result => console.log('Result from child:', result));
```

```cjs displayName="child.js"
process.on('message', msg => {
  console.log('Received from parent:', msg);
  process.send('done');
});
```

`fork()` gives you a ready-made, structured-clone-based IPC channel (`.send()` / `'message'`), so you don't have to parse stdout yourself the way you would with `spawn()`.

### Things to watch for

- Avoid `exec()` for anything that could produce a large output — use `spawn()` and stream it instead.
- Always handle the `'exit'` and `'close'` events so you notice failures and clean up resources (open file descriptors, temporary files) instead of leaking them.
- If any part of the command comes from user input, prefer `execFile()`/`spawn()` with an argument array over `exec()`, which runs through a shell and is vulnerable to shell injection if arguments aren't sanitized.

## Worker Threads

`worker_threads` was added to let you run JavaScript in parallel, in threads within the _same_ process, specifically to move CPU-bound work off the main thread without blocking it. Unlike `child_process`, workers share the same process — no OS-level process to spin up, and no fully separate memory space.

|                  | Worker Threads                    | Child Process         |
| :--------------- | :-------------------------------- | :-------------------- |
| Context          | Same process                      | Separate process      |
| Memory           | Shareable via `SharedArrayBuffer` | Isolated              |
| Startup overhead | Low                               | Higher                |
| Communication    | `postMessage()` (fast)            | stdio or IPC (slower) |

### Example: offloading CPU-bound work

```cjs displayName="main.js"
const { Worker } = require('node:worker_threads');

const worker = new Worker('./hash-worker.js', {
  workerData: 'user-password',
});
worker.on('message', hash => console.log('Computed hash:', hash));
worker.on('error', err => console.error('Worker failed:', err));
```

```cjs displayName="hash-worker.js"
const { parentPort, workerData } = require('node:worker_threads');
const { scryptSync, randomBytes } = require('node:crypto');

const salt = randomBytes(16);
const hash = scryptSync(workerData, salt, 64).toString('hex');

parentPort.postMessage(hash);
```

Password hashing, image/video transforms, encryption, and parsing very large in-memory payloads are classic candidates: they're pure CPU work, and running them on the main thread would stall every other request Node.js is handling in the meantime.

### Sharing memory

Workers can share memory directly using `SharedArrayBuffer` together with the `Atomics` API for safe concurrent access, instead of copying data back and forth with `postMessage()`. This avoids serialization overhead for large buffers, but you're now responsible for coordinating access yourself — it opens the door to the same race-condition class of bugs found in traditional multi-threaded programming.

### Things to watch for

- Worker threads are for CPU-bound work, not I/O — a worker still has to wait on I/O just like the main thread would, so spinning one up for a database call or a network request adds overhead for no benefit.
- Spinning up a worker has a real cost. For small, frequent tasks, that setup overhead can outweigh the benefit — consider a pool of long-lived workers (see the [`workerpool`](https://www.npmjs.com/package/workerpool) package) instead of creating one per task.

## Cluster

`cluster` solves a different problem: a single Node.js process only uses one CPU core. To take advantage of a multi-core machine for a network server, `cluster` forks multiple full copies of your process (each one a `child_process` under the hood) that all listen on the same port.

### Example: scaling an HTTP server across cores

```cjs
const cluster = require('node:cluster');
const http = require('node:http');
const { availableParallelism } = require('node:os');

if (cluster.isPrimary) {
  const numCPUs = availableParallelism();

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    if (worker.exitedAfterDisconnect) {
      // A voluntary exit (e.g. worker.disconnect() or cluster.disconnect())
      // — don't respawn.
      return;
    }

    console.log(`Worker ${worker.process.pid} died, restarting`);
    cluster.fork();
  });
} else {
  http
    .createServer((req, res) => {
      res.writeHead(200);
      res.end('handled by worker ' + process.pid);
    })
    .listen(3000);
}
```

The primary process (`cluster.isPrimary`) forks one worker per core and restarts any worker that exits unexpectedly. Each worker (`cluster.isWorker`) runs your normal server code, unaware that it's one of several. The `worker.exitedAfterDisconnect` flag distinguishes a voluntary exit (e.g. during a graceful shutdown via `worker.disconnect()` or `cluster.disconnect()`) from a crash — without checking it, a deliberate shutdown would keep spawning new workers instead of winding down.

### How the workers share one port

Rather than relying on an OS-level mechanism, the primary process itself distributes incoming connections to its workers — by default in a round-robin fashion (`cluster.SCHED_RR`), which is the default on every platform except Windows. This is configurable via `cluster.schedulingPolicy`. (You may see older material claim this is done via `SO_REUSEPORT`; that's not how Node's cluster module does it by default.)

### `isPrimary` / `isWorker`

`cluster.isPrimary` is `true` in the process that forks workers; `cluster.isWorker` is `true` in the forked workers themselves. (You may also see `cluster.isMaster` in older code — it still works, but it's a deprecated alias for `isPrimary`.)

### Things to watch for

- Workers are separate processes, so **they don't share memory**. In-memory sessions, caches, or rate limiters won't be visible across workers — use an external store like Redis for anything that needs to be shared.
- Always handle a worker's `'exit'` event and decide whether to restart it; an unhandled crash silently reduces your server's capacity. Check `worker.exitedAfterDisconnect` so a graceful shutdown doesn't get treated as a crash and endlessly respawn workers.
- In production, most teams use a process manager (PM2, systemd, or a container orchestrator) instead of hand-rolling restart/reload logic with `cluster` directly.

## Choosing between them

A quick decision guide:

- **Running an external program, or a script in another language?** → `child_process` (`spawn`/`execFile`).
- **Running another Node.js script as an isolated process, with structured messaging?** → `child_process.fork()`.
- **Have CPU-bound JavaScript blocking your event loop (hashing, image processing, big computations)?** → `worker_threads`.
- **Want to use all the CPU cores to handle more traffic to your server?** → `cluster` (or a process manager/orchestrator that does the equivalent at the infrastructure level).

These aren't mutually exclusive. A common pattern for something like an image-upload service is to combine all three: `cluster` to spread incoming requests across cores, and `worker_threads` (or `child_process`) within each worker to do the actual image processing without blocking that worker's event loop.

## Further reading

- [`child_process` API reference](https://nodejs.org/api/child_process.html)
- [`worker_threads` API reference](https://nodejs.org/api/worker_threads.html)
- [`cluster` API reference](https://nodejs.org/api/cluster.html)
- [The Node.js Event Loop](/learn/asynchronous-work/event-loop-timers-and-nexttick)
- [Don't Block the Event Loop](/learn/asynchronous-work/dont-block-the-event-loop)
