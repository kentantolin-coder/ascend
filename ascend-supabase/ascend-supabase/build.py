"""Build the standalone Supabase edition of Ascend from the artifact source.

    python3 build.py  [path/to/artifact/index.html]

Reads the artifact page (default ../ascend100/index.html), adds a full HTML document shell,
loads supabase-js + config.js + platform.js, and swaps the few claude.ai-specific bits
(share instructions, artifact link) for login-based equivalents. Writes ./index.html.
"""
import pathlib, re, sys

HERE = pathlib.Path(__file__).resolve().parent
src = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent / "ascend100" / "index.html"
s = src.read_text()

def rep(old, new, regex=False):
    global s
    if regex:
        s2, n = re.subn(old, new, s, flags=re.S)
    else:
        n = s.count(old); s2 = s.replace(old, new)
    if n != 1:
        sys.exit(f"build: expected 1 match, found {n}: {old[:80]!r}")
    s = s2

# 1. Coach "add athlete" card: share instructions -> account creation form
rep(r'<div class="g"><p class="eyebrow">Add an athlete</p>.*?<span class="muted" style="font-size:12px" id="linkOut"></span></div></div>',
    '<div class="g"><p class="eyebrow">Add an athlete</p><p class="muted" style="margin:0 0 12px;font-size:13px;max-width:70ch">Create a login for each athlete. They sign in with this email and password, see only their own data, and appear here right away.</p>'
    '<form id="addStu" class="stack"><div class="f2"><label class="f">Full name<input id="as-name" required autocomplete="off"></label><label class="f">Email<input id="as-email" type="email" required autocomplete="off"></label></div>'
    '<label class="f">Password<span class="row" style="flex-wrap:nowrap"><input id="as-pw" required minlength="8" autocomplete="new-password"><button type="button" class="btn sm" id="as-gen">Generate</button></span></label><button class="btn primary" type="submit">Create athlete account</button></form>'
    '<div id="as-out" class="muted" style="font-size:13px;margin-top:10px">${(window.ASCEND&&window.ASCEND.lastOut)||""}</div>'
    '<div class="row" style="margin-top:10px"><button type="button" class="btn sm ghost" data-copylink>Copy app link</button><span class="muted" style="font-size:12px" id="linkOut"></span></div></div></div>', regex=True)
rep('const u="https://claude.ai/artifact/DHhYgEVbxtjV1adntZWmS1";', 'const u=location.origin+location.pathname;')

# 2. Athlete page header: password reset + pause/reactivate
rep('<span class="pill ${cls}" style="font-size:12px">${esc(stx)}</span></div></div>',
    '<div class="row"><span class="pill ${cls}" style="font-size:12px">${esc(stx)}</span>${id!=="__me"?`<button type="button" class="btn sm" data-resetpw="${esc(id)}">Reset password</button><button type="button" class="btn sm ghost" data-active="${esc(id)}" data-on="${roster[id]&&roster[id].active===false?0:1}">${roster[id]&&roster[id].active===false?"Reactivate":"Pause access"}</button>`:""}</div></div></div>')

# 3. Me tab: account card with sign out / change password
rep('      <div class="g">\n        <div class="row between">\n          <div><p class="eyebrow">Data</p>',
    '      <div class="g"><div class="row between"><div><p class="eyebrow">Account</p><span class="mono" id="acctEmail" style="font-size:13px"></span></div>'
    '<div class="row"><button type="button" class="btn sm" id="chgPw">Change password</button><button type="button" class="btn sm ghost" id="signOut">Sign out</button></div></div></div>\n'
    '      <div class="g">\n        <div class="row between">\n          <div><p class="eyebrow">Data</p>')

# 4. Onboarding copy no longer refers to claude.ai
s = s.replace("only works when this app is open on claude.ai", "needs a signed-in coach account")
s = s.replace("Claude drafting works when the app is open on claude.ai", "AI drafting needs the ai edge function deployed")
s = s.replace("AI estimates work when the app is opened on claude.ai.", "AI estimates need the ai edge function deployed.")

HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#04060d">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Ascend">
<link rel="manifest" href="manifest.json">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="icon-512.png">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}html,body{margin:0}body{font-size:14px}img{max-width:100%}[hidden]{display:none!important}</style>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>
<script src="config.js"></script>
<script src="platform.js"></script>
</head>
<body>
"""
s = s.replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '')
(HERE / "index.html").write_text(HEAD + s + "\n</body>\n</html>\n")
print("built", HERE / "index.html", len(s), "bytes")
