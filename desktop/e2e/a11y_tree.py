"""Print the Inbox Max window's accessibility tree (AT-SPI), optionally only
the comma-separated roles given as the first argument. Used by inspect-a11y.mjs."""
import sys, time
import pyatspi

ROLES = set(sys.argv[1].split(',')) if len(sys.argv) > 1 else None

def find_app():
    for _ in range(40):
        for app in pyatspi.Registry.getDesktop(0):
            if app is not None and 'inboxmax' in (app.name or ''):
                return app
        time.sleep(0.25)
    raise SystemExit('app not on the accessibility bus')

def walk(node, depth=0):
    try:
        yield depth, node
        for child in node:
            yield from walk(child, depth + 1)
    except Exception:
        return

for depth, node in walk(find_app()):
    role = node.getRoleName()
    if ROLES and role not in ROLES:
        continue
    states = node.getState()
    extras = []
    if states.contains(pyatspi.STATE_FOCUSABLE): extras.append('focusable')
    if states.contains(pyatspi.STATE_FOCUSED): extras.append('FOCUSED')
    if states.contains(pyatspi.STATE_PRESSED): extras.append('pressed')
    if states.contains(pyatspi.STATE_CHECKED): extras.append('checked')
    if states.contains(pyatspi.STATE_EXPANDED): extras.append('expanded')
    attrs = dict(a.split(':', 1) for a in node.getAttributes() if ':' in a)
    for key in ('level', 'current', 'keyshortcuts', 'live'):
        if key in attrs: extras.append(f'{key}={attrs[key]}')
    print(f"{'  ' * min(depth, 10)}{role}: {node.name!r}{' [' + ', '.join(extras) + ']' if extras else ''}")
