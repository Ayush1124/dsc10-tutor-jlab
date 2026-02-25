import re

# Banned pandas-only methods not available in babypandas
BANNED_METHODS = {
    "rename", "fillna", "dropna", "pivot_table", "melt",
    "stack", "unstack", "iloc", "loc", "apply", "map",
    "astype", "copy", "concat", "merge", "rolling",
    "expanding", "resample", "query", "eval", "transform",
}


def extract_code_blocks(text: str) -> list:
    pattern = r"```(?:\w+)?\s*\n(.*?)\n```"
    return [match.group(1) for match in re.finditer(pattern, text, re.DOTALL)]


def check_pandas_only_methods(text: str) -> dict:
    code_blocks = extract_code_blocks(text)
    violations = []
    
    for block in code_blocks:
        for method in BANNED_METHODS:
            if re.search(rf"\.{method}\s*\(", block):
                violations.append(method)
    
    return {
        "found_issues": len(violations) > 0,
        "violations": list(set(violations)),
        "num_violations": len(violations),
    }


def validate_response(text: str, raise_on_violations: bool = False) -> tuple:
    result = check_pandas_only_methods(text)
    
    if raise_on_violations and result["found_issues"]:
        methods = ", ".join(result["violations"])
        raise ValueError(f"Code contains banned pandas-only methods: {methods}")
    
    return not result["found_issues"], result
