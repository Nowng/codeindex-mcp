import os
import sys

ROOT = "/home/sensei/works/codeindex-mcp"
sys.path.insert(0, ROOT + "/CodeIndex/src")
sys.path.insert(0, ROOT + "/_cpp_patch")

import sitecustomize  # applies the monkeypatch

from cpp_strategy import CppParsingStrategy  # noqa: E402
from code_index_mcp.indexing.strategies.strategy_factory import StrategyFactory  # noqa: E402

sf = StrategyFactory()
has_cpp = ".cpp" in sf._strategies
print("sitecustomize:", os.path.basename(sitecustomize.__file__))
print("factory .cpp registered:", has_cpp)
if has_cpp:
    print("  lang:", sf._strategies[".cpp"].get_language_name())

LL = "/home/sensei/Workspace/llama.cpp/"
for rel in ["src/unicode.cpp", "src/llama.cpp", "common/common.cpp"]:
    text = open(LL + rel, encoding="utf-8").read()
    syms, finfo = CppParsingStrategy().parse_file(rel, text)
    F = [s.split("::", 1)[-1] for s, si in syms.items() if si.type == "function"]
    M = [s.split("::", 1)[-1] for s, si in syms.items() if si.type == "method"]
    CC = [s.split("::", 1)[-1] for s, si in syms.items() if si.type == "class"]
    summary = "== %s == lines=%d syms=%d F=%d M=%d C=%d imports=%d" % (
        rel, finfo.line_count, len(syms), len(F), len(M), len(CC), len(finfo.imports),
    )
    print(summary)
    for n in F[:4]:
        print("   F", n)
    for n in M[:4]:
        print("   M", n)
    for n in CC[:4]:
        print("   C", n)
