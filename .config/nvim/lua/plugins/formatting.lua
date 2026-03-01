return {
  {
    "stevearc/conform.nvim",
    opts = {
      formatters_by_ft = {
        -- Biome first, fallback to Prettier
        javascript = { "biome", "prettier", stop_after_first = true },
        javascriptreact = { "biome", "prettier", stop_after_first = true },
        typescript = { "biome", "prettier", stop_after_first = true },
        typescriptreact = { "biome", "prettier", stop_after_first = true },
        json = { "biome", "prettier", stop_after_first = true },
        jsonc = { "biome", "prettier", stop_after_first = true },
        -- Prettier only
        graphql = { "prettier" },
        css = { "prettier" },
        scss = { "prettier" },
        html = { "prettier" },
        markdown = { "prettier" },
      },
    },
  },
}
