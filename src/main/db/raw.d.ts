/**
 * 让 TS 认识 vite 的 ?raw 导入（schema.sql 以字符串形式内联进主进程包，
 * 这样打包后无需额外拷贝 .sql 文件）。
 */
declare module '*.sql?raw' {
  const content: string
  export default content
}
