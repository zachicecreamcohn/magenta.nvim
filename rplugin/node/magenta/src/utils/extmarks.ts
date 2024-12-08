import { Buffer, Neovim } from 'neovim'

// additonal helpers that neovim node client doesn't have for some reason

export function setExtMark({
  nvim,
  buffer,
  namespace,
  row,
  col,
}: {
  nvim: Neovim,
  buffer: Buffer,
  namespace: number,
  row: number,
  col: number,
}): Promise<number> {
  // return nvim.lua(`return vim.api.nvim_buf_set_extmark(${buffer.id}, ${namespace}, ${row}, ${col}, {})`) as Promise<number>
  return nvim.call(`nvim_buf_set_extmark`, [buffer.id, namespace, row, col, {}]) as Promise<number>
}

export function getExtMark({
  nvim,
  buffer,
  namespace,
  markId
}: {
  nvim: Neovim,
  buffer: Buffer,
  namespace: number,
  markId: number
}): Promise<[number, number]> {
  return nvim.call(`nvim_buf_get_extmark_by_id`, [buffer.id, namespace, markId, {}]) as Promise<[number, number]>;
}
