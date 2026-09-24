#!/usr/bin/env python3
"""Drives `claude auth login` in a pty for a separate CLAUDE_CONFIG_DIR.
Usage: claude-login-driver.py <config_dir> <log> <fifo>
The URL to open is written to <log>; the authorization code is read from <fifo>."""
import os, pty, sys, select, time, errno
cfg, log, fifo = sys.argv[1:4]
os.makedirs(cfg, exist_ok=True)
if not os.path.exists(fifo): os.mkfifo(fifo)
env = dict(os.environ, CLAUDE_CONFIG_DIR=cfg, TERM="dumb", COLUMNS="200", BROWSER="/bin/true")
pid, fd = pty.fork()
if pid == 0:
    os.execvpe("claude", ["claude", "auth", "login", "--claudeai"], env)
out = open(log, "ab", buffering=0)
ffd = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
start = time.time()
while time.time() - start < 1800:
    r, _, _ = select.select([fd, ffd], [], [], 1)
    if fd in r:
        try: data = os.read(fd, 4096)
        except OSError: break
        if not data: break
        out.write(data)
    if ffd in r:
        code = os.read(ffd, 4096)
        if code:
            os.write(fd, code.strip() + b"\r")
            out.write(b"\n[driver] code envoye\n")
try: _, status = os.waitpid(pid, 0); out.write(f"\n[driver] exit {status}\n".encode())
except ChildProcessError: pass
