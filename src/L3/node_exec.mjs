import { spawn } from "node:child_process";

const command = "ls -la";
const cwd = process.cwd();
// 解析命令和参数
const [cmd, ...args] = command.split(" ");

const child = spawn(cmd, args, {
  cwd,
  stdio: "inherit", // 实时输出到控制台
  shell: true,
});

let errorMsg = "";

child.on("error", (error) => {
  errorMsg = error.message;
});

child.on("close", (code) => {
  if (code === 0) {
    process.exit(0);
  } else {
    if (errorMsg) {
      console.error(`错误: ${errorMsg}`);
    }
    process.exit(code || 1);
  }
});
