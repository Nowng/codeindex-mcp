"""
Independent C / C++ parsing strategy (regex + brace-scanning heuristic).

This file lives OUTSIDE the upstream CodeIndex repo -- in the plugin's
``_cpp_patch/`` directory -- so it survives ``git pull`` of the upstream repo.
It is wired into the upstream ``StrategyFactory`` at runtime by
``sitecustomize.py`` (see that module), which patches
``StrategyFactory._initialize_strategies`` to register this parser for every C /
C++ extension.

Design goals
------------
* Zero third-party dependencies (no tree-sitter / libclang) -- pure stdlib, so
  it works on any host the plugin is installed on.
* Robust -- each file is parsed inside a ``try/except``; a parse failure never
  breaks the build (the index builder already skips files that throw).
* Good coverage of common C / C++: free functions, ``class`` / ``struct`` types
  and member methods (recorded as ``ClassName.method``), ``#include`` imports,
  and a best-effort within-file call graph (``called_by``).

Import note
-----------
The upstream ``src/`` is placed on ``PYTHONPATH`` at runtime, so
``code_index_mcp`` is importable as a top-level package from here. We import the
real ``SymbolInfo`` / ``FileInfo`` and the ``ParsingStrategy`` base class so the
output is byte-for-byte compatible with the upstream strategies.
"""

from __future__ import annotations

import logging
import re
from typing import Dict, List, Optional, Tuple

from code_index_mcp.indexing.models import SymbolInfo, FileInfo
from code_index_mcp.indexing.strategies.base_strategy import ParsingStrategy

logger = logging.getLogger(__name__)

# All C / C++ extensions this strategy owns. They MUST be DOT-PREFIXED and
# LOWERCASED to match the upstream ``_process_file``:
#     ext = Path(file_path).suffix.lower()      # e.g. ".cpp"
CPP_EXTENSIONS = [
    ".c",
    ".cpp",
    ".cc",
    ".cxx",
    ".c++",
    ".h",
    ".hpp",
    ".h++",
    ".hh",
    ".hxx",
    ".ipp",
    ".inl",
    ".tcc",
    ".gpp",
    ".m",       # Objective-C
    ".mm",      # Objective-C++
]

# ---------------------------------------------------------------------------
# Regexes
# ---------------------------------------------------------------------------

# ``#include <...`` / ``#include "..."``  (best-effort import list).
_INCLUDE = re.compile(r'^\s*#\s*include\s*[<"]([^>"]+)[>"]')

# ``class`` / ``struct`` declaration at the start of a line, with an optional
# ``template <...>`` header. The opening brace may be on this or a later line.
_CLASS = re.compile(
    r"(?m)^[ \t]*(?:template\s*<[^>]*>[ \t]*)?(?:class|struct)[ \t]+([A-Za-z_]\w*)"
)

# A head identifier immediately followed by ``(`` -- candidate function /
# method head. We take the LAST such match on a line.
_HEAD_CALL = re.compile(r"([A-Za-z_~][A-Za-z0-9_]*)\s*\(")

# Characters allowed in a return-type / qualifier prefix (letters, digits,
# underscore, ``*``/``&``/template angle brackets and ``::``), plus spaces.
_TYPE_CHARS = set(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_*:<>"
) | {" "}
# A valid type prefix must end on a "type-ish" character (not a dangling space).
_TYPE_TAIL = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_*:>&")

# Qualifiers / specifiers that may trail a head line before ``{`` / ``;``.
_HEAD_QUALIFIERS = re.compile(
    r"\s*(?:const|noexcept|override|final|mutable|volatile"
    r"|throw\s*\([^)]*\)|=\s*(?:default|delete|0)|&|\)\s*const)?[ \t]*$"
)

# Tokens we never treat as a function / method head.
_HEAD_KEYWORDS = {
    "if", "else", "for", "while", "switch", "return", "sizeof", "catch",
    "do", "case", "new", "delete", "typeof", "alignof", "decltype", "static_cast",
    "const_cast", "dynamic_cast", "reinterpret_cast", "noexcept", "and", "or",
    "not", "throw", "try", "using", "typedef", "template",
}

# ---------------------------------------------------------------------------
# Strategy
# ---------------------------------------------------------------------------


class CppParsingStrategy(ParsingStrategy):
    """Dependency-free C / C++ parsing strategy (heuristic, stdlib only)."""

    def get_language_name(self) -> str:
        return "cpp"

    def get_supported_extensions(self) -> List[str]:
        return list(CPP_EXTENSIONS)

    def parse_file(
        self, file_path: str, content: str
    ) -> Tuple[Dict[str, SymbolInfo], FileInfo]:
        symbols: Dict[str, SymbolInfo] = {}
        functions: List[str] = []
        classes: List[str] = []
        imports: List[str] = []

        try:
            self._extract_imports(content, imports)
            self._scan_symbols(file_path, content, symbols, functions, classes)
            self._build_calls(file_path, content, symbols)
        except Exception as exc:  # pragma: no cover - defensive, never breaks build
            logger.warning(f"Error parsing C++ file {file_path}: {exc}")
            symbols = {}
            functions = []

        file_info = FileInfo(
            language="cpp",
            line_count=len(content.splitlines()),
            symbols={"functions": functions, "classes": classes},
            imports=imports,
        )
        return symbols, file_info

    # -- imports -------------------------------------------------------------
    @staticmethod
    def _extract_imports(content: str, imports: List[str]) -> None:
        for line in content.splitlines():
            m = _INCLUDE.match(line)
            if m:
                imports.append(m.group(1))

    # -- symbol extraction (two passes) --------------------------------------
    def _scan_symbols(
        self,
        file_path: str,
        content: str,
        symbols: Dict[str, SymbolInfo],
        functions: List[str],
        classes: List[str],
    ) -> None:
        """Pass 1: classes/structs; Pass 2: functions / member methods."""

        def line_of(pos: int) -> int:
            """1-based line number of a character position in ``content``."""
            return content[:pos].count("\n") + 1

        # --- Pass 1: classes / structs (brace-matched ranges) ----------------
        class_defs: List[Tuple[str, int, int]] = []  # (name, start_line, end_line)
        for m in _CLASS.finditer(content):
            name = m.group(1)
            start = line_of(m.start())
            brace = content.find("{", m.end() - 1)
            end = start
            if brace != -1:
                end = self._brace_end(content, brace)
            class_defs.append((name, start, end))
            self._add(symbols, classes, "class", start, f"class {name}", file_path, name, end_line=end)

        def enclosing_for(line: int) -> Optional[str]:
            """Innermost class whose [start,end] contains ``line`` (or None)."""
            found: Optional[str] = None
            for cname, cstart, cend in class_defs:
                if cstart <= line <= cend:
                    found = cname
            return found

        lines = content.split("\n")

        def next_significant(idx: int) -> Optional[int]:
            for j in range(idx + 1, len(lines)):
                st = lines[j].strip()
                if st and not st.startswith("//") and not st.startswith("/*"):
                    return j
            return None

        # Line offsets: char position of each line's start (for brace matching).
        line_start = [0]
        for _ln in lines[:-1]:
            line_start.append(line_start[-1] + len(_ln) + 1)
        if len(line_start) < len(lines):
            line_start.append(len(content))

        def head_end_line(idx):
            # 1-based end line of the head at `idx`: brace-match '{', else ';' line.
            for j in range(idx, len(lines)):
                st = lines[j].strip()
                if st == "" or st.startswith("//") or st.startswith("/*"):
                    continue
                if "{" in lines[j]:
                    return self._brace_end(content, line_start[j] + lines[j].index("{"))
                if ";" in lines[j]:
                    return j + 1
            return idx + 1

        # --- Pass 2: functions / methods -------------------------------------
        for idx, raw in enumerate(lines):
            s = raw.strip()
            if s == "" or s.startswith("//") or s.startswith("/*"):
                continue

            head = self._detect_head(s, idx, class_defs, lines, next_significant)
            if head is None:
                continue

            name, kind = head
            base = name[1:] if name.startswith("~") else name
            enclosing = enclosing_for(idx + 1)
            qname = f"{enclosing}.{base}" if (enclosing is not None and kind != "class") else base
            sid = self._create_symbol_id(file_path, qname)
            if sid not in symbols:
                symbols[sid] = SymbolInfo(
                    type="method" if kind == "method" else "function",
                    file=file_path,
                    line=idx + 1,
                    end_line=head_end_line(idx),
                    signature=self._signature(idx, s, content),
                    docstring=None,
                )
                functions.append(qname)

    # -- head detection ------------------------------------------------------
    def _detect_head(
        self,
        s: str,
        head_idx: int,
        class_defs: List[Tuple[str, int, int]],
        lines: List[str],
        next_significant,
    ) -> Optional[Tuple[str, str]]:
        """Return ``(name, kind)`` for a valid head line, else ``None``.

        ``kind`` is ``"method"`` or ``"function"`` (classes are handled in pass 1).
        The rule is deliberately conservative (return-type prefix + ``{``/``;``
        terminator, possibly on the next significant line) to avoid false
        positives on ordinary expression / call statements.
        """
        matches = list(_HEAD_CALL.finditer(s))
        if not matches:
            return None
        m = matches[-1]
        name = m.group(1)
        if name in _HEAD_KEYWORDS:
            return None

        pre = s[: m.start()].rstrip()
        type_like = bool(pre) and all(c in _TYPE_CHARS for c in pre) and pre[-1] in _TYPE_TAIL

        # Terminator: after trimming qualifiers the line ends with '{' or ';',
        # (optionally with the brace/semicolon on the next significant line).
        trimmed = _HEAD_QUALIFIERS.sub("", s).rstrip()
        term = trimmed.endswith("{") or trimmed.endswith(";")
        if not term and trimmed.endswith(")"):
            j = next_significant(head_idx)
            if j is not None:
                st = lines[j].strip()
                term = st.startswith("{") or st.startswith(";")
        if not term:
            return None

        enclosing = None
        for cname, cstart, cend in class_defs:
            if cstart <= (head_idx + 1) <= cend:
                enclosing = cname
        if enclosing is None and not type_like:
            return None
        return name, "method" if enclosing is not None else "function"

    # -- ranges / signatures -------------------------------------------------
    def _brace_end(self, content: str, open_idx: int) -> int:
        """1-based line of the ``}`` that closes the `{` at ``open_idx``."""
        depth = 0
        for i in range(open_idx, len(content)):
            c = content[i]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return content[: i + 1].count("\n") + 1
        return content[: open_idx + 1].count("\n") + 1

    def _signature(self, head_idx: int, head_line: str, content: str) -> str:
        """Header text from the head line up to its first ``{`` / ``;``."""
        parts = content.split("\n")
        header_parts: List[str] = []
        for j in range(head_idx, len(parts)):
            p = parts[j]
            header_parts.append(p)
            if "{" in p or ";" in p:
                break
        header = " ".join(header_parts).strip()
        cut = len(header)
        for k, ch in enumerate(header):
            if ch in "{;":
                cut = k
                break
        header = header[:cut].rstrip().rstrip(",").strip()
        return header or head_line.strip()

    # -- call graph ----------------------------------------------------------
    def _build_calls(
        self, file_path: str, content: str, symbols: Dict[str, SymbolInfo]
    ) -> None:
        """Best-effort within-file ``called_by`` graph (each char scanned once)."""
        if not symbols:
            return
        targets: Dict[str, set] = {}
        for sid, info in symbols.items():
            short = sid.split("::", 1)[-1]
            targets.setdefault(short, set()).add(sid)
            head = short.rsplit(".", 1)[-1].rsplit("::", 1)[-1]
            if head != short:
                targets.setdefault(head, set()).add(sid)

        tok_re = re.compile(r"[A-Za-z_]\w*")
        all_lines = content.split("\n")
        for sid, info in symbols.items():
            if info.type not in ("function", "method", "class"):
                continue
            start = max(0, min((info.line or 1) - 1, len(all_lines)))
            end = max(start, min((info.end_line or start + 200), len(all_lines)))
            body = "\n".join(all_lines[start:end])
            for tok in tok_re.finditer(body):
                matched = targets.get(tok.group(0))
                if not matched:
                    continue
                for tid in matched:
                    if tid == sid:
                        continue
                    target = symbols[tid]
                    if sid not in target.called_by:
                        target.called_by.append(sid)

    # -- small helpers -------------------------------------------------------
    def _add(
        self,
        symbols: Dict[str, SymbolInfo],
        classes: List[str],
        stype: str,
        ln: int,
        sig: str,
        file_path: str,
        name: str,
        end_line: Optional[int] = None,
    ) -> None:
        sid = self._create_symbol_id(file_path, name)
        if sid not in symbols:
            symbols[sid] = SymbolInfo(
                type=stype, file=file_path, line=ln, end_line=end_line, signature=sig
            )
            if stype == "class" and name not in classes:
                classes.append(name)
