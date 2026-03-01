return {
  -- Auto-save
  {
    "okuuva/auto-save.nvim",
    event = { "InsertLeave", "TextChanged" },
    opts = {
      debounce_delay = 1000,
    },
  },

  -- tmux/Neovim seamless navigation
  {
    "christoomey/vim-tmux-navigator",
    keys = {
      { "<C-h>", "<cmd>TmuxNavigateLeft<cr>" },
      { "<C-j>", "<cmd>TmuxNavigateDown<cr>" },
      { "<C-k>", "<cmd>TmuxNavigateUp<cr>" },
      { "<C-l>", "<cmd>TmuxNavigateRight<cr>" },
    },
  },

  -- Multi cursor
  {
    "mg979/vim-visual-multi",
    event = "VeryLazy",
  },

  -- Emmet
  {
    "mattn/emmet-vim",
    ft = { "html", "css", "javascriptreact", "typescriptreact", "vue", "svelte" },
  },
}
