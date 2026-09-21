"""
Runtime injection of an independent C / C++ parsing strategy into the upstream
Code Index MCP ``StrategyFactory`` -- WITHOUT modifying the upstream repo, so a
later ``git pull`` of ``CodeIndex/`` keeps working.

Placement & wiring
-------------------
This lives in the plugin's ``_cpp_patch/`` directory (OUTSIDE ``CodeIndex/``) and
is added to ``PYTHONPATH`` by ``scripts/setup.cjs`` and by
``src/core/codeIndexClient.py``'s backend launch. Python imports this
``sitecustomize`` at startup; it registers ``CppParsingStrategy`` for every C /
C++ extension so the deep index extracts symbols from ``.cpp`` / ``.h`` files.

Never raises
------------
A failure here must NOT break the backend process (that would stop every tool).
On any error we write to ``stderr`` and leave the upstream behavior untouched, so
C / C++ simply falls back to the (empty) parser instead of crashing.
"""

import os
import sys

_PATCH_DIR = os.path.dirname(os.path.abspath(__file__))
_PLUG_ROOT = os.path.dirname(_PATCH_DIR)
_CODE_SRC = os.path.join(_PLUG_ROOT, "CodeIndex", "src")

for _p in (_PATCH_DIR, _CODE_SRC):
    if _p and _p not in sys.path:
        sys.path.insert(0, _p)

try:
    from code_index_mcp.indexing.strategies.strategy_factory import StrategyFactory
    from cpp_strategy import CppParsingStrategy

    _ORIG_INIT = StrategyFactory._initialize_strategies

    def _patched_initialize_strategies(self):
        # Run the original registration (all web / scripting languages), then add
        # the C / C++ parser so it is treated as a SPECIALIZED strategy -- not the
        # no-op fallback. Re-entrant lock + explicit flag keep it idempotent.
        _ORIG_INIT(self)
        with self._lock:
            cpp = CppParsingStrategy()
            for _ext in cpp.get_supported_extensions():
                self._strategies[_ext] = cpp
            self._initialized = True

    StrategyFactory._initialize_strategies = _patched_initialize_strategies
except Exception as _exc:  # pragma: no cover - never break interpreter startup
    sys.stderr.write(
        "[codeindex] C++ strategy patch did not apply (falling back to no-op): %s\n"
        % (_exc,)
    )
