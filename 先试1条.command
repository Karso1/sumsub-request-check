#!/bin/zsh
cd "${0:A:h}" || exit 1
if [[ -z "$SUMSUB_CLIENT_ID" ]]; then
  read "SUMSUB_CLIENT_ID?请输入 Sumsub 客户端 ID："
  export SUMSUB_CLIENT_ID
fi
echo "Sumsub Request Check：先处理 1 条 UID。"
node request-check.mjs --limit 1
run_code=$?
echo ""
echo "运行结束，退出码：$run_code。结果请查看同目录的 results.jsonl。"
echo "按回车关闭此窗口。"
read
