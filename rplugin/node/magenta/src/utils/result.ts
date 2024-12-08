export type Result<T> = {
  status: 'ok',
  result: T
} | {
  status: 'error',
  error: string
}
