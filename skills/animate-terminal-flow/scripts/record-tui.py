#!/usr/bin/env python3
"""Record a terminal UI in a pseudo-terminal as an asciicast v2 file.

The child runs in a pty of a fixed size while a steps file drives it: waits,
keys, regex waits on its output, shell commands (for live edits in watch
mode), named markers, SGR mouse clicks and resizes. The recorder answers the
queries a Kitty-protocol terminal such as Ghostty answers (DA1/DA2,
XTVERSION, cursor position, cell and text-area size, OSC 4/10/11/12 colors,
DECRQM, the Kitty keyboard and graphics queries), so the app decides it may
draw real images, and the cast holds every byte it drew.

Output: the cast (`o`, `i`, `m` and `r` events) and, beside it,
`<cast>.record.json` with the child's pid, exit status, the queries answered,
the modes the app turned on, and a timeline of the steps.

Python 3 standard library only. The child gets a clean environment by
default (see --pass-env), so nothing from the parent terminal (tmux, cmux,
Kitty, SSH) leaks into the app's detection.

Usage:
  record-tui.py --cols 120 --rows 34 --cwd REPO --steps steps.json \\
      --out out.cast [--env K=V ...] [--terminal ghostty] -- command args...
"""

import argparse
import codecs
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

ESC = 0x1B

DEFAULT_THEME = {
    "fg": "#d8dee9",
    "bg": "#111318",
    "cursor": "#d2a8ff",
    "palette": [
        "#1d2027", "#f2777a", "#7ee787", "#e5c07b", "#6cb6ff", "#d2a8ff", "#56d4dd", "#c9d1d9",
        "#5c6370", "#ff938a", "#a5f3b0", "#f6d58e", "#9ccfff", "#e2c5ff", "#8be9f0", "#f0f3f6",
    ],
}

# What each terminal preset puts in the environment and answers. `graphics`
# says whether the Kitty graphics query gets an OK.
TERMINALS = {
    "ghostty": {
        "env": {"TERM": "xterm-256color", "COLORTERM": "truecolor", "TERM_PROGRAM": "ghostty", "TERM_PROGRAM_VERSION": "1.4.0"},
        "xtversion": "ghostty 1.4.0",
        "graphics": True,
    },
    "kitty": {
        "env": {"TERM": "xterm-256color", "COLORTERM": "truecolor", "KITTY_WINDOW_ID": "1"},
        "xtversion": "kitty(0.42.0)",
        "graphics": True,
    },
    "xterm": {
        "env": {"TERM": "xterm-256color", "COLORTERM": "truecolor"},
        "xtversion": "XTerm(390)",
        "graphics": False,
    },
}

# Parent variables kept in the clean environment.
PASS_ENV = ["HOME", "USER", "LOGNAME", "SHELL", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "NVM_DIR", "NVM_BIN", "PNPM_HOME"]

KEYS = {
    "up": "\x1b[A", "down": "\x1b[B", "right": "\x1b[C", "left": "\x1b[D",
    "home": "\x1b[H", "end": "\x1b[F", "pgup": "\x1b[5~", "pgdn": "\x1b[6~",
    "enter": "\r", "return": "\r", "tab": "\t", "backtab": "\x1b[Z", "esc": "\x1b", "escape": "\x1b",
    "space": " ", "backspace": "\x7f", "delete": "\x1b[3~", "ctrl-c": "\x03",
}

MOUSE_BUTTONS = {"left": 0, "middle": 1, "right": 2, "wheel-up": 64, "wheel-down": 65, "move": 35}

CSI_RE = re.compile(rb"\x1b\[([\x30-\x3f]*)([\x20-\x2f]*)([\x40-\x7e])")
CSI_PARTIAL_RE = re.compile(rb"\x1b\[[\x30-\x3f]*[\x20-\x2f]*\Z")
# Plain text for waitFor: everything that isn't an escape sequence.
STRIP_RE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[_P^X][^\x1b]*\x1b\\|[()*+].|.)|[\x00-\x08\x0b-\x1f\x7f]")


class Failure(Exception):
    pass


def hex_to_x11(color):
    h = color.lstrip("#")
    return "rgb:" + "/".join(h[i:i + 2] * 2 for i in (0, 2, 4))


def palette256(theme, index):
    if index < 16:
        return theme["palette"][index]
    if index < 232:
        n = index - 16
        steps = [0, 95, 135, 175, 215, 255]
        r, g, b = steps[n // 36], steps[(n // 6) % 6], steps[n % 6]
    else:
        r = g = b = 8 + (index - 232) * 10
    return "#%02x%02x%02x" % (r, g, b)


class Recorder:
    def __init__(self, args, theme, term):
        self.args = args
        self.theme = theme
        self.term = term
        self.cols = args.cols
        self.rows = args.rows
        self.cell_w, self.cell_h = args.cell_px
        self.pid = None
        self.fd = None
        self.exit_status = None
        self.eof = False
        self.t0 = None
        self.cast = None
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.carry = b""
        self.plain = []  # stripped text chunks for waitFor
        self.search_from = 0  # offset into plain text where the next waitFor starts by default
        self.modes = {}
        self.modes_seen = set()
        self.kitty_kbd = [0]
        self.cursor = [0, 0]
        self.saved_cursor = [0, 0]
        self.kitty_pending = None
        self.queries = {}
        self.timeline = []
        self.markers = []

    # ---- time and cast -------------------------------------------------
    def now(self):
        return time.monotonic() - self.t0

    def event(self, kind, data):
        self.cast.write(json.dumps([round(self.now(), 6), kind, data], ensure_ascii=False) + "\n")

    def note_query(self, name):
        self.queries[name] = self.queries.get(name, 0) + 1

    # ---- child ------------------------------------------------------------
    def spawn(self, command, env):
        winsize = struct.pack("HHHH", self.rows, self.cols, self.cols * self.cell_w, self.rows * self.cell_h)
        pid, fd = pty.fork()
        if pid == 0:
            try:
                fcntl.ioctl(0, termios.TIOCSWINSZ, winsize)
                os.chdir(self.args.cwd)
                os.execvpe(command[0], command, env)
            except Exception as error:  # noqa: BLE001 - report and leave the child
                os.write(2, ("record-tui: cannot start %r: %s\r\n" % (command[0], error)).encode())
            os._exit(127)
        self.pid, self.fd = pid, fd
        self.t0 = time.monotonic()
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)

    def reap(self):
        if self.exit_status is not None:
            return True
        try:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
        except ChildProcessError:
            self.exit_status = "unknown"
            return True
        if pid == self.pid:
            self.exit_status = os.waitstatus_to_exitcode(status)
            return True
        return False

    def write(self, data):
        if isinstance(data, str):
            data = data.encode("utf-8")
        while data:
            try:
                n = os.write(self.fd, data)
            except OSError as error:
                raise Failure("could not write to the child: %s" % error) from error
            data = data[n:]

    def send_input(self, text):
        self.event("i", text)
        self.write(text)

    def reply(self, text, name):
        self.note_query(name)
        self.write(text)

    # ---- reading ------------------------------------------------------------
    def pump(self, seconds, until=None):
        """Read output for up to `seconds`; stop early when until() is true."""
        deadline = time.monotonic() + seconds
        while True:
            if until and until():
                return True
            left = deadline - time.monotonic()
            if left <= 0:
                return False
            if self.eof:
                self.reap()
                time.sleep(min(left, 0.02))
                continue
            ready, _, _ = select.select([self.fd], [], [], min(left, 0.05))
            if ready:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    data = b""
                if not data:
                    self.eof = True
                    tail = self.decoder.decode(b"", final=True)
                    if tail:
                        self.event("o", tail)
                    continue
                text = self.decoder.decode(data)
                if text:
                    self.event("o", text)
                self.scan(data)

    def plain_text(self):
        joined = "".join(self.plain)
        self.plain = [joined]
        return joined

    # ---- the query scanner -------------------------------------------------
    def add_plain(self, raw):
        if not raw:
            return
        text = raw.decode("utf-8", "replace")
        self.track_text(text)
        clean = STRIP_RE.sub("", text.replace("\r", ""))
        if clean:
            self.plain.append(clean)

    def track_text(self, text):
        row, col = self.cursor
        for ch in text:
            if ch == "\r":
                col = 0
            elif ch == "\n":
                row = min(row + 1, self.rows - 1)
            elif ch == "\b":
                col = max(col - 1, 0)
            elif ch >= " " and not (0x300 <= ord(ch) <= 0x36F) and ord(ch) < 0x10EEEE:
                col += 1
                if col >= self.cols:
                    col = 0
                    row = min(row + 1, self.rows - 1)
        self.cursor = [row, col]

    def scan(self, data):
        buf = self.carry + data
        self.carry = b""
        i, n = 0, len(buf)
        while i < n:
            j = buf.find(b"\x1b", i)
            if j < 0:
                self.add_plain(buf[i:])
                return
            self.add_plain(buf[i:j])
            if j + 1 >= n:
                self.carry = buf[j:]
                return
            kind = buf[j + 1]
            if kind == 0x5B:  # CSI
                m = CSI_RE.match(buf, j)
                if not m:
                    if CSI_PARTIAL_RE.match(buf, j) and n - j < 256:
                        self.carry = buf[j:]
                        return
                    i = j + 1
                    continue
                self.on_csi(m.group(1).decode("latin1"), m.group(2).decode("latin1"), m.group(3).decode("latin1"))
                i = m.end()
            elif kind == 0x5D:  # OSC, ended by BEL or ST
                bel = buf.find(b"\x07", j + 2)
                st = buf.find(b"\x1b\\", j + 2)
                ends = [e for e in (bel, st) if e >= 0]
                if not ends:
                    self.carry = buf[j:]
                    return
                end = min(ends)
                self.on_osc(buf[j + 2:end].decode("utf-8", "replace"), "\x07" if end == bel else "\x1b\\")
                i = end + (1 if end == bel else 2)
            elif kind in (0x5F, 0x50, 0x5E, 0x58):  # APC, DCS, PM, SOS: ended by ST
                st = buf.find(b"\x1b\\", j + 2)
                if st < 0:
                    self.carry = buf[j:]
                    return
                body = buf[j + 2:st]
                if kind == 0x5F:
                    self.on_apc(body)
                elif kind == 0x50:
                    self.on_dcs(body)
                i = st + 2
            elif kind in (0x28, 0x29, 0x2A, 0x2B):  # charset designation: 3 bytes
                if j + 2 >= n:
                    self.carry = buf[j:]
                    return
                i = j + 3
            else:
                if kind == 0x37:
                    self.saved_cursor = list(self.cursor)
                elif kind == 0x38:
                    self.cursor = list(self.saved_cursor)
                elif kind == 0x63:  # RIS
                    self.cursor = [0, 0]
                i = j + 2

    def on_csi(self, params, inter, final):
        prefix = params[:1] if params[:1] in ("?", ">", "<", "=") else ""
        body = params[len(prefix):]
        nums = [int(p) if p.isdigit() else 0 for p in body.split(";")] if body else []
        first = nums[0] if nums else 0
        row, col = self.cursor
        if final in "Hf" and not prefix and not inter:
            r = (nums[0] if len(nums) > 0 and nums[0] else 1) - 1
            c = (nums[1] if len(nums) > 1 and nums[1] else 1) - 1
            if r != row:
                self.plain.append("\n")
            self.cursor = [min(r, self.rows - 1), min(c, self.cols - 1)]
        elif final == "A" and not prefix:
            self.cursor = [max(row - (first or 1), 0), col]
            self.plain.append("\n")
        elif final in "BE" and not prefix:
            self.cursor = [min(row + (first or 1), self.rows - 1), 0 if final == "E" else col]
            self.plain.append("\n")
        elif final == "F" and not prefix:
            self.cursor = [max(row - (first or 1), 0), 0]
            self.plain.append("\n")
        elif final == "C" and not prefix:
            self.cursor = [row, min(col + (first or 1), self.cols - 1)]
            self.plain.append(" ")
        elif final == "D" and not prefix:
            self.cursor = [row, max(col - (first or 1), 0)]
        elif final == "G" and not prefix:
            self.cursor = [row, min((first or 1) - 1, self.cols - 1)]
        elif final == "d" and not prefix:
            self.cursor = [min((first or 1) - 1, self.rows - 1), col]
            self.plain.append("\n")
        elif final == "c" and not inter:
            if prefix == "" and first == 0:
                self.reply("\x1b[?62;22c", "DA1")
            elif prefix == ">" and first == 0:
                self.reply("\x1b[>1;10;0c", "DA2")
        elif final == "q" and prefix == ">" and not inter:
            self.reply("\x1bP>|%s\x1b\\" % self.term["xtversion"], "XTVERSION")
        elif final == "n" and not inter:
            if first == 5 and not prefix:
                self.reply("\x1b[0n", "DSR status")
            elif first == 6:
                r, c = self.cursor
                self.reply("\x1b[%s%d;%dR" % ("?" if prefix == "?" else "", r + 1, c + 1), "DSR cursor (approximate)")
        elif final == "t" and not prefix and not inter:
            if first == 14:
                self.reply("\x1b[4;%d;%dt" % (self.rows * self.cell_h, self.cols * self.cell_w), "CSI 14 t text area")
            elif first == 16:
                self.reply("\x1b[6;%d;%dt" % (self.cell_h, self.cell_w), "CSI 16 t cell size")
            elif first == 18:
                self.reply("\x1b[8;%d;%dt" % (self.rows, self.cols), "CSI 18 t grid size")
        elif final == "p" and inter == "$":
            mode = first
            if prefix == "?":
                state = self.modes.get(mode)
                value = 1 if state else 2
                self.reply("\x1b[?%d;%d$y" % (mode, value), "DECRQM ?%d" % mode)
            else:
                self.reply("\x1b[%d;%d$y" % (mode, 2 if mode in (4, 20) else 0), "DECRQM %d" % mode)
        elif final == "u" and not inter:
            if prefix == "?":
                self.reply("\x1b[?%du" % self.kitty_kbd[-1], "kitty keyboard query")
            elif prefix == ">":
                self.kitty_kbd.append(first)
                self.modes["kitty-keyboard"] = first
            elif prefix == "<":
                for _ in range(max(first, 1)):
                    if len(self.kitty_kbd) > 1:
                        self.kitty_kbd.pop()
                self.modes["kitty-keyboard"] = self.kitty_kbd[-1]
            elif prefix == "=":
                self.kitty_kbd[-1] = first
                self.modes["kitty-keyboard"] = first
            elif not prefix and not params:
                self.cursor = list(self.saved_cursor)
        elif final == "s" and not prefix and not params:
            self.saved_cursor = list(self.cursor)
        elif final in "hl" and prefix == "?":
            on = final == "h"
            for mode in nums:
                self.modes[mode] = on
                if on:
                    self.modes_seen.add(mode)
                if mode == 1049 and on:
                    self.saved_cursor = list(self.cursor)
                    self.cursor = [0, 0]
                elif mode == 1049:
                    self.cursor = list(self.saved_cursor)

    def on_osc(self, body, terminator):
        code, _, rest = body.partition(";")
        if code in ("10", "11", "12") and rest == "?":
            color = {"10": self.theme["fg"], "11": self.theme["bg"], "12": self.theme.get("cursor", self.theme["fg"])}[code]
            self.reply("\x1b]%s;%s%s" % (code, hex_to_x11(color), terminator), "OSC %s color" % code)
        elif code == "4" and rest:
            parts = rest.split(";")
            for k in range(0, len(parts) - 1, 2):
                if parts[k + 1] == "?" and parts[k].isdigit():
                    idx = int(parts[k])
                    if 0 <= idx < 256:
                        self.reply("\x1b]4;%d;%s%s" % (idx, hex_to_x11(palette256(self.theme, idx)), terminator), "OSC 4 palette")

    def on_dcs(self, body):
        if body.startswith(b"+q"):
            self.reply("\x1bP0+r\x1b\\", "XTGETTCAP")
        elif body.startswith(b"$q"):
            self.reply("\x1bP0$r\x1b\\", "DECRQSS")

    def on_apc(self, body):
        if not body.startswith(b"G"):
            return
        control, _, _payload = body[1:].partition(b";")
        keys = {}
        for pair in control.decode("latin1").split(","):
            k, _, v = pair.partition("=")
            if k:
                keys[k] = v
        self.note_query("kitty graphics command")
        if not self.term["graphics"]:
            return
        more = keys.get("m") == "1"
        if self.kitty_pending is not None and "a" not in keys and "i" not in keys and "f" not in keys:
            first = self.kitty_pending  # a continuation chunk: only m (and q) are set
            if "q" in keys:
                first["q"] = keys["q"]
        else:
            first = keys
        self.kitty_pending = first if more else None
        if more:
            return
        action = first.get("a", "t")
        quiet = first.get("q", "0")
        image = first.get("i") or first.get("I")
        if action == "q":
            if quiet != "2":
                self.reply("\x1b_Gi=%s;OK\x1b\\" % first.get("i", "0"), "kitty graphics query")
        elif action in ("t", "T", "p", "f") and quiet == "0" and image:
            ident = "i=%s" % first["i"] if "i" in first else "I=%s" % first["I"]
            if "p" in first:
                ident += ",p=%s" % first["p"]
            self.reply("\x1b_G%s;OK\x1b\\" % ident, "kitty graphics OK")

    # ---- steps ---------------------------------------------------------------
    def plain_since(self, offset):
        return self.plain_text()[offset:]

    def mark_input(self):
        self.search_from = len(self.plain_text())

    def run_step(self, index, step):
        started = self.now()
        label = next((k for k in step if k not in ("timeout", "flags", "from", "times", "interval", "delay", "cwd", "force", "allowFail", "comment")), "comment")
        entry = {"index": index, "step": label, "t": round(started, 3)}
        if "wait" in step:
            self.pump(step["wait"] / 1000)
        elif "send" in step:
            text = step["send"]
            delay = step.get("delay", 0) / 1000
            self.mark_input()
            if delay:
                for ch in text:
                    self.send_input(ch)
                    self.pump(delay)
            else:
                self.send_input(text)
        elif "key" in step:
            name = step["key"].lower()
            seq = KEYS.get(name, step["key"] if len(step["key"]) == 1 else None)
            if seq is None:
                raise Failure("step %d: unknown key %r (known: %s)" % (index, step["key"], ", ".join(sorted(KEYS))))
            times = step.get("times", 1)
            interval = step.get("interval", 120) / 1000
            self.mark_input()
            for k in range(times):
                self.send_input(seq)
                if k < times - 1:
                    self.pump(interval)
        elif "waitFor" in step:
            pattern = re.compile(step["waitFor"], re.IGNORECASE if "i" in step.get("flags", "") else 0)
            timeout = step.get("timeout", 10000) / 1000
            where = step.get("from", "input")
            offset = 0 if where == "start" else len(self.plain_text()) if where == "now" else self.search_from
            found = {}

            def matched():
                text = self.plain_since(offset)
                m = pattern.search(text)
                if m:
                    found["m"] = m
                    return True
                return False

            if not self.pump(timeout, matched):
                tail = self.plain_since(offset)[-1500:]
                raise Failure("step %d: waitFor %r timed out after %d ms.\nLast output (ANSI stripped):\n%s" % (index, step["waitFor"], timeout * 1000, tail))
            entry["matched"] = found["m"].group(0)[:120]
            self.search_from = offset + found["m"].end()
        elif "sh" in step:
            result = subprocess.run(step["sh"], shell=True, cwd=step.get("cwd", self.args.cwd), capture_output=True, text=True, timeout=step.get("timeout", 30000) / 1000)
            entry["exit"] = result.returncode
            if result.returncode != 0 and not step.get("allowFail"):
                raise Failure("step %d: sh exited %d: %s\n%s" % (index, result.returncode, step["sh"], result.stderr[-1500:]))
            self.mark_input()
        elif "mark" in step:
            name = str(step["mark"])
            self.event("m", name)
            self.markers.append({"name": name, "t": round(self.now(), 6)})
        elif "mouse" in step:
            spec = step["mouse"]
            tracking = any(self.modes.get(m) for m in (1000, 1002, 1003))
            if not step.get("force") and not tracking:
                raise Failure("step %d: mouse step, but the app has not turned on mouse reporting (?1000/?1002/?1003)" % index)
            if not step.get("force") and not self.modes.get(1006):
                raise Failure("step %d: mouse step, but the app has not turned on SGR mouse mode (?1006)" % index)
            col, row = int(spec["col"]), int(spec["row"])
            button = spec.get("button", "left")
            if button not in MOUSE_BUTTONS:
                raise Failure("step %d: unknown mouse button %r" % (index, button))
            code = MOUSE_BUTTONS[button]
            action = spec.get("action", "click")
            self.mark_input()
            if button.startswith("wheel") or button == "move":
                self.send_input("\x1b[<%d;%d;%dM" % (code, col, row))
            else:
                if action in ("click", "press"):
                    self.send_input("\x1b[<%d;%d;%dM" % (code, col, row))
                if action == "click":
                    self.pump(spec.get("hold", 60) / 1000)
                if action in ("click", "release"):
                    self.send_input("\x1b[<%d;%d;%dm" % (code, col, row))
        elif "resize" in step:
            spec = step["resize"]
            if isinstance(spec, str):
                cols, rows = (int(v) for v in spec.lower().split("x"))
            else:
                cols, rows = int(spec["cols"]), int(spec["rows"])
            self.cols, self.rows = cols, rows
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, cols * self.cell_w, rows * self.cell_h))
            self.event("r", "%dx%d" % (cols, rows))
            self.mark_input()
        elif "comment" in step:
            pass
        else:
            raise Failure("step %d: unknown step %s" % (index, json.dumps(step)))
        entry["ms"] = round((self.now() - started) * 1000)
        self.timeline.append(entry)

    def stop(self, quit_keys, quit_timeout):
        """Quit with keys, then SIGTERM and SIGKILL the child's pid only."""
        how = "exited"
        if not self.reap() and quit_keys:
            try:
                self.send_input(quit_keys)
            except Failure:
                pass
            how = "quit keys"
        if not self.pump(quit_timeout, self.reap):
            how = "SIGTERM"
            try:
                os.kill(self.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            if not self.pump(3, self.reap):
                how = "SIGKILL"
                try:
                    os.kill(self.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.pump(2, self.reap)
        # Drain what is left, briefly.
        self.pump(0.3, lambda: self.eof)
        return how


def parse_cell(value):
    m = re.fullmatch(r"(\d+)x(\d+)", value)
    if not m:
        raise argparse.ArgumentTypeError("cell size is WxH in pixels, such as 18x38")
    return int(m.group(1)), int(m.group(2))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cols", type=int, required=True)
    parser.add_argument("--rows", type=int, required=True)
    parser.add_argument("--cwd", default=os.getcwd(), help="working directory for the command and sh steps")
    parser.add_argument("--env", action="append", default=[], metavar="K=V", help="extra environment variable (repeatable)")
    parser.add_argument("--pass-env", action="append", default=[], metavar="NAME", help="also keep this parent variable")
    parser.add_argument("--inherit-env", action="store_true", help="start from the full parent environment instead of a clean one")
    parser.add_argument("--steps", required=True, help="JSON steps file: a list, or an object with a steps list")
    parser.add_argument("--out", required=True, help="the .cast file to write")
    parser.add_argument("--terminal", choices=sorted(TERMINALS), default="ghostty", help="which terminal to impersonate (default ghostty)")
    parser.add_argument("--cell-px", type=parse_cell, default=(18, 38), help="cell size in device pixels reported to the app (default 18x38)")
    parser.add_argument("--theme", help="JSON file with fg, bg, cursor and a 16-color palette")
    parser.add_argument("--quit", default="q", help="keys sent at the end to quit (default q; empty for none)")
    parser.add_argument("--quit-timeout", type=float, default=5.0, help="seconds to wait after the quit keys")
    parser.add_argument("--title", default=None)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("no command given after --")
    args.cwd = os.path.abspath(args.cwd)

    theme = dict(DEFAULT_THEME)
    if args.theme:
        with open(args.theme) as handle:
            theme.update(json.load(handle))
    term = TERMINALS[args.terminal]

    with open(args.steps) as handle:
        steps = json.load(handle)
    if isinstance(steps, dict):
        steps = steps["steps"]

    if args.inherit_env:
        env = dict(os.environ)
        for name in list(env):
            if name.startswith(("TMUX", "KITTY_", "GHOSTTY_", "CMUX_", "WEZTERM_", "KONSOLE_", "TERM_PROGRAM", "SSH_", "ITERM_", "VSCODE_")):
                env.pop(name)
    else:
        env = {name: os.environ[name] for name in PASS_ENV + args.pass_env if name in os.environ}
    env.setdefault("LANG", "en_US.UTF-8")
    env.update(term["env"])
    env["COLUMNS"] = str(args.cols)
    env["LINES"] = str(args.rows)
    for pair in args.env:
        key, sep, value = pair.partition("=")
        if not sep:
            parser.error("--env wants K=V, got %r" % pair)
        env[key] = value

    rec = Recorder(args, theme, term)
    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    rec.cast = open(args.out, "w", buffering=1, encoding="utf-8")
    header = {
        "version": 2,
        "width": args.cols,
        "height": args.rows,
        "timestamp": int(time.time()),
        "command": " ".join(command),
        "title": args.title or os.path.basename(args.out),
        "env": {k: env[k] for k in ("TERM", "COLORTERM", "TERM_PROGRAM", "SHELL") if k in env},
        "theme": {"fg": theme["fg"], "bg": theme["bg"], "palette": ":".join(theme["palette"])},
        "x_terminal": {"preset": args.terminal, "xtversion": term["xtversion"], "cell_px": {"w": args.cell_px[0], "h": args.cell_px[1]}, "cursor": theme.get("cursor")},
    }
    rec.cast.write(json.dumps(header) + "\n")

    rec.spawn(command, env)
    print("record-tui: child pid %d" % rec.pid, file=sys.stderr)
    failure = None
    try:
        for index, step in enumerate(steps):
            if rec.reap() and not rec.eof:
                rec.pump(0.2)
            if rec.exit_status is not None:
                raise Failure("step %d: the child exited early with status %s" % (index, rec.exit_status))
            rec.run_step(index, step)
    except Failure as error:
        failure = str(error)
    except KeyboardInterrupt:
        failure = "interrupted"
    how = rec.stop(args.quit, args.quit_timeout)
    rec.cast.close()

    report = {
        "cast": os.path.abspath(args.out),
        "pid": rec.pid,
        "command": command,
        "cwd": args.cwd,
        "size": {"cols": args.cols, "rows": args.rows},
        "cell_px": {"w": args.cell_px[0], "h": args.cell_px[1]},
        "terminal": args.terminal,
        "env": {k: v for k, v in env.items() if k not in ("PATH",)},
        "exit_status": rec.exit_status,
        "stopped_by": how,
        "duration": round(rec.now(), 3),
        "failure": failure,
        "markers": rec.markers,
        "queries_answered": rec.queries,
        "modes_at_exit": {str(k): v for k, v in rec.modes.items()},
        "modes_turned_on": sorted(str(m) for m in rec.modes_seen),
        "timeline": rec.timeline,
    }
    with open(args.out + ".record.json", "w") as handle:
        json.dump(report, handle, indent=2)
    if failure:
        print("record-tui: FAILED: %s" % failure, file=sys.stderr)
        sys.exit(2)
    print("record-tui: wrote %s (%.1fs, %d markers, stopped by %s, exit %s)" % (args.out, rec.now(), len(rec.markers), how, rec.exit_status), file=sys.stderr)


if __name__ == "__main__":
    main()
