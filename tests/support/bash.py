"""Locating a bash that can run this repository's shell scripts.

On Windows the PATH often resolves ``bash`` to the WSL launcher
(``C:\\Windows\\System32\\bash.exe``). That launcher eats the backslashes of a
Windows path and dies with "C:Octopdockerdocker-entrypoint.sh: No such file or
directory". Git Bash runs the same script fine, so prefer it; without a usable
bash the caller skips the test.
"""

from __future__ import annotations

import os
import shutil


def resolve_bash() -> str | None:
    """Return a bash that can open a script given by its Windows path."""
    if os.name == "nt":
        for env in ("ProgramFiles", "ProgramFiles(x86)"):
            base = os.environ.get(env)
            if not base:
                continue
            candidate = os.path.join(base, "Git", "bin", "bash.exe")
            if os.path.isfile(candidate):
                return candidate
        found = shutil.which("bash")
        if found:
            system32 = os.path.join(os.environ.get("SYSTEMROOT", r"C:\Windows"), "System32")
            if os.path.normcase(os.path.dirname(found)) == os.path.normcase(system32):
                return None
            return found
        return None
    return shutil.which("bash")
