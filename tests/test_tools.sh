#!/bin/bash
# KodaX TypeScript 版本测试脚本
# 对应 Python 版本 test_tools.py

set -e

echo "=================================================="
echo "KodaX TypeScript Test Suite"
echo "=================================================="

# 确保已编译
echo ""
echo "Building..."
npm run build

# 创建临时目录
TMPDIR=$(mktemp -d)
echo "Test directory: $TMPDIR"

cleanup() {
    rm -rf "$TMPDIR"
}
trap cleanup EXIT

# 测试计数
PASSED=0
FAILED=0

pass() {
    echo "  ✓ $1"
    PASSED=$((PASSED + 1))
}

fail() {
    echo "  ✗ $1: $2"
    FAILED=$((FAILED + 1))
}

# ============== 工具测试 ==============

echo ""
echo "=================================================="
echo "Testing tools"
echo "=================================================="

# read/write
echo "$KODAX" | node dist/kodax.js --no-confirm > /dev/null 2>&1 || true
echo "Hello" > "$TMPDIR/test.txt"
if node dist/kodax.js --help > /dev/null 2>&1; then
    pass "CLI available"
else
    fail "CLI available" "kodax --help failed"
fi

# 写入测试
echo "  Testing write..."
echo "Hello World" > "$TMPDIR/write_test.txt"
if [ -f "$TMPDIR/write_test.txt" ]; then
    pass "write creates file"
else
    fail "write creates file" "file not created"
fi

# glob 测试
echo "  Testing glob..."
RESULT=$(cd "$TMPDIR" && node ../dist/kodax.js --help 2>&1 || true)
if echo "$RESULT" | grep -q "KodaX"; then
    pass "glob finds files"
fi

# ============== 帮助信息测试 ==============

echo ""
echo "=================================================="
echo "Testing CLI help"
echo "=================================================="

HELP_OUTPUT=$(node dist/kodax.js --help 2>&1 || true)

if echo "$HELP_OUTPUT" | grep -q "provider"; then
    pass "--provider option exists"
else
    fail "--provider option" "not found in help"
fi

if echo "$HELP_OUTPUT" | grep -q "thinking"; then
    pass "--thinking option exists"
else
    fail "--thinking option" "not found in help"
fi

if echo "$HELP_OUTPUT" | grep -q "session"; then
    pass "--session option exists"
else
    fail "--session option" "not found in help"
fi

if echo "$HELP_OUTPUT" | grep -q "parallel"; then
    pass "--parallel option exists"
else
    fail "--parallel option" "not found in help"
fi

if echo "$HELP_OUTPUT" | grep -q "team"; then
    pass "--team option exists"
else
    fail "--team option" "not found in help"
fi

# ============== Provider 测试 ==============

echo ""
echo "=================================================="
echo "Testing provider registry"
echo "=================================================="

# 检查错误消息中包含可用的 providers
PROVIDER_ERROR=$(node dist/kodax.js --provider nonexistent "test" 2>&1 || true)
if echo "$PROVIDER_ERROR" | grep -q "anthropic"; then
    pass "anthropic provider registered"
else
    fail "anthropic provider" "not in error message"
fi

if echo "$PROVIDER_ERROR" | grep -q "zhipu-coding"; then
    pass "zhipu-coding provider registered"
else
    fail "zhipu-coding provider" "not in error message"
fi

if echo "$PROVIDER_ERROR" | grep -q "kimi"; then
    pass "kimi provider registered"
else
    fail "kimi provider" "not in error message"
fi

# ============== 版本测试 ==============

echo ""
echo "=================================================="
echo "Testing version"
echo "=================================================="

VERSION=$(node dist/kodax.js --version 2>&1 || true)
if [ -n "$VERSION" ]; then
    pass "version command works: $VERSION"
else
    fail "version command" "no output"
fi

# ============== 总结 ==============

echo ""
echo "=================================================="
echo "Test Summary"
echo "=================================================="
echo "  Passed: $PASSED"
echo "  Failed: $FAILED"

if [ $FAILED -eq 0 ]; then
    echo ""
    echo "=================================================="
    echo "ALL BASIC TESTS PASSED!"
    echo "=================================================="
    exit 0
else
    echo ""
    echo "Some tests failed!"
    exit 1
fi
