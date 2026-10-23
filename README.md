# Sumsub Request Check

## 中文概览

从 Excel 的 `UID` 列读取用户，先查看 Sumsub 初始状态。仅在状态为 `Documents requested` 时执行 `View files → Set as active → Request check`；其他状态记录后跳过。每次复用同一个 Chrome 窗口和标签页。脚本会执行真实操作，先用 `--limit 1` 核对。

安装 Node.js、Python 3、Google Chrome，然后在本目录执行 `npm install` 和 `python3 -m pip install openpyxl`。在终端设置 `SUMSUB_CLIENT_ID` 为你的 Sumsub 客户端 ID，再运行下面的命令或双击 `.command` 启动器。请勿将 Excel、浏览器配置或结果日志提交到 GitHub。

知识点：Excel 字符串读取避免长 UID 精度丢失、Playwright 浏览器自动化、状态门控、超时与错误分类、JSONL/CSV 审计日志、按工作簿哈希断点续跑。

## English overview

Reads UIDs from Excel, checks each applicant's initial Sumsub status, and requests a new check only for `Documents requested`. It reuses one Chrome tab. Install Node.js, Python 3, Chrome, `npm install`, and `python3 -m pip install openpyxl`. Set `SUMSUB_CLIENT_ID` in the terminal before running. Keep workbooks, browser profiles, and result logs out of GitHub.

Concepts: preserving long UID strings, Playwright automation, status gates, timeout handling, JSONL/CSV audit logs, and workbook-hash-based resume.

This tool reads the `UID` column from an Excel worksheet and checks the initial Sumsub applicant status. It proceeds to **View files → Set as active → Request check** only when the initial status is **Documents requested**. If View files is absent, it proceeds directly to Request check. Other initial statuses are counted, recorded, and skipped. After Request check is clicked, a change from Documents requested to any other status records success.

## Run

On macOS, double-click `先试1条.command` to verify the flow, then double-click `双击开始运行.command` for the full worksheet. The automation reuses one Sumsub tab in one separate Chrome window throughout the run.

Open Terminal in this folder and run:

```bash
node request-check.mjs --dry-run
node request-check.mjs --limit 1
node request-check.mjs
```

Every live run opens the dedicated Chrome profile and **waits for you to press Enter in Terminal after logging in**. No UID is processed before Enter. Keep the terminal and browser open until the run finishes.

Run only one copy at a time. If the dedicated Chrome window is still open, return to its existing Terminal run. After that run stops, close the dedicated Chrome window before starting a new run. The launcher checks for another run or Chrome profile use and prints a short explanation instead of a Chrome startup stack trace.

Options: `--sheet Sheet2`, `--start-row 100`, `--limit 10`, `--input /absolute/path/file.xlsx`, `--dry-run`. By default, the tool reads the first worksheet in the only `.xlsx` file in this folder (ignoring Excel's temporary `~$` file). `results-detailed.csv` records each UID's initial status, whether View files and Set as active completed, whether Request check was clicked, why a step did not run, the final status, and the outcome. `results.jsonl` preserves the full history. Resume progress is tied to the contents of the Excel file and selected worksheet: restarting with the same file resumes, while replacing or editing the file starts a new set. Older result entries without a workbook version are kept for reference but are not used for resume. Rows with errors can be checked again on a later run. Use Ctrl+C to stop after the current browser operation.

Terminal progress combines distinct UIDs already completed for this workbook version with UIDs checked in the current run. It shows the overall count/total, percentage, elapsed time, current UID and initial status. Each completed UID's line includes cumulative counts for Approved, Resubmission requested, Pending, successful resubmissions, applicants explicitly not found in search, and errors grouped by reason. Errors remain eligible for retry; when a retry changes the outcome, the old error is removed from the cumulative count. Full error text and step details remain in `results-detailed.csv`.

The tool requires Python `openpyxl`, Node.js, Google Chrome, the `playwright` npm dependency, and `SUMSUB_CLIENT_ID`. It intentionally stops on a search result that does not visibly match the full UID.
