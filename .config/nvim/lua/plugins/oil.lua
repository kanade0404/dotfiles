return {
  {
    "stevearc/oil.nvim",
    dependencies = { "nvim-tree/nvim-web-devicons" },
    keys = {
      { "-", "<cmd>Oil<cr>", desc = "Open parent directory" },
    },
    opts = {
      default_file_explorer = true,
      view_options = {
        show_hidden = true,
      },
    },
  },
}
