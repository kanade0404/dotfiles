-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua

local opt = vim.opt

-- Indentation
opt.tabstop = 2
opt.shiftwidth = 2
opt.expandtab = true

-- Line numbers (hybrid)
opt.number = true
opt.relativenumber = true

-- Clipboard (system)
opt.clipboard = "unnamedplus"

-- Auto write
opt.autowriteall = true

-- Japanese encoding support
opt.fileencodings = { "utf-8", "euc-jp", "shift_jis", "cp932" }

-- Colorscheme
vim.g.lazyvim_colorscheme = "github_light_default"
