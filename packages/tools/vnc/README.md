# tophat-vnc

A scripted VNC (RFB) console into another Mac on the LAN, for driving GUI-only
apps that expose no accessibility tree (vendor configuration tools, lock screens).

A UI-automation tool drives *this* Mac. `tophat-cdp` drives a browser. `tophat-vnc` drives
another Mac's screen. Extend this tool rather than writing another VNC script.

## Use

```sh
tophat-vnc locked                     # locked | unlocked | unreachable over ssh (exit 1 = locked, 7 = unreachable)
tophat-vnc unlock                     # only if locked: type the account password at the lock screen, then confirm from a remote shell
tophat-vnc ensure-unlocked            # same, name for scripts: `tophat-vnc ensure-unlocked && ssh HOST ...`
tophat-vnc ocr /tmp/s.png             # capture + OCR: "x,y WxH  text", ready to click
tophat-vnc ocr /tmp/s.png --crop 1600,440,950,280
tophat-vnc read /tmp/s.png            # OCR an image already on disk
tophat-vnc click X Y                  # framebuffer PIXELS, not AppKit points
tophat-vnc triple X Y                 # select a text field's whole contents
tophat-vnc --delay 150 type 192.168.1.60
tophat-vnc key enter
tophat-vnc raw move 100 100 click 1 pause 1 capture /tmp/s.png
```

Targets live in a JSON file (`$TOPHAT_VNC_HOSTS`, default `~/.config/tophat/vnc-hosts.json`):
`{ "lab": { "host": "lab-mac.local", "port": 5900, "user": "account", "secret": "<vault id of its login password>" } }`
(optional `unlockX`/`unlockY` override the password field position). The password is read with `tophat-pass`
(`$TOPHAT_VNC_PASS_BIN` names another command with the same `get ID --raw -n` interface). `--target NAME` or
`$TOPHAT_VNC_TARGET` picks one; the first entry is the default. Never pass credentials on the command line.

## The eight things that cost time, encoded here

1. **Apple's server wants ARD auth, not the VNC password.** It offers RFB
   security type 30 (Diffie-Hellman) and `vncdo -p PASSWORD` alone fails with
   `EOFError: EOF when reading a line` from `ardRequestCredentials`, because it
   is prompting for a username on a closed stdin. Pass `-u ACCOUNT -p PASSWORD`;
   the pair is validated against the macOS account. The legacy VNC password set
   by `kickstart -setvncpw` is a separate, unnecessary path.
2. **Enable the server first**, on the target, idempotent:
   `sudo /System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart -activate -configure -access -on -clientopts -setvnclegacy -vnclegacy yes -setvncpw -vncpw <pw> -restart -agent -privs -all`.
   Nothing listening on 5900 beforehand is normal: `com.apple.screensharing` is
   launch-on-demand, so a plain `nc -z` succeeds whether or not it is configured.
3. **Typing faster than ~150 ms per key silently drops characters** at the
   macOS lock screen. vncdotool's default is 10 ms, which produced three failed
   unlocks with a password that was provably correct. `--delay 200` for the
   lock screen; the default here is 120.
4. **Click the password field before typing.** The lock screen does not reliably
   hold keyboard focus. The field sits at the screen's horizontal centre, about
   91% of the way down (1889,1962 on a 3840x2160 framebuffer).
5. **The first capture after connecting is often the bare wallpaper**, with no
   lock-screen UI drawn at all and nothing for OCR to find. Send a mouse move
   or a key, pause, then capture. Blank OCR is not a black screen: check
   `ImageStat` means before concluding the display is asleep.
6. **Confirm input is landing before debugging anything else.** On the target,
   `pmset -g assertions` shows a `UserIsActive` assertion named
   `...tickle.nxevent service:IOHIDSystem ... process:ScreensharingAgent` while
   events are arriving. That separates "events are not delivered" from "events
   are delivered and the app ignored them".
7. **The console re-locks after 5 minutes** (`sysadminctl -screenLock status`). The cause is usually the screensaver idle timer (default 20 min) launching the saver with a password (`kLWLockFromScreenSaverIdleLaunch` in loginwindow's log); setting `idleTime 0` on the target stops it.
   Hold it open for the length of a job with a transient
   `nohup caffeinate -d -i -u -t 5400 &` over ssh, and `pkill` it when done;
   that changes no setting on the machine.

8. **`unlock` never types into an unlocked desktop and never puts the password in argv** it checks the lock
   state over ssh first (an unreachable target is an error, not "unlocked"), drives vncdotool's Python API with the
   credentials on stdin, retries once, and re-checks. The old path passed `-p PASSWORD` and `type PASSWORD` to the
   vncdo CLI, so the password sat in `ps` for the length of the call.

## Reading the screen

These windows have no accessibility tree, so OCR is the only way to find a
control. `ocr`/`read` run macOS Vision locally through pyobjc and print each
string with a pixel box, so the output doubles as a click map. Small or
low-contrast text (radio-button labels, three-digit Art-Net address fields)
reads much better if you crop to the panel and upscale 3x with PIL first.

Coordinates are framebuffer pixels throughout: a 4K display is 3840x2160 here,
twice the 1920x1080 points a window-level UI tool reports on the same screen.

## Known limitation

A VNC console reaches the screen, not the network. An app that unicasts to a
device the target Mac cannot route to will fail silently no matter how well the
GUI is driven; check `route -n get <ip>` on the target before blaming the clicks.
