#!/bin/zsh
cd "${0:A:h}" || exit 1
echo "Sumsub Request Check：先处理 1 条 UID。"
node request-check.mjs --limit 1
run_code=$?
echo ""
echo "运行结束，退出码：$run_code。结果请查看同目录的 results.jsonl。"
echo "按回车关闭此窗口。"
read
