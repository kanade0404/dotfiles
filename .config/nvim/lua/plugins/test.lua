return {
  {
    "nvim-neotest/neotest",
    dependencies = {
      "marilari88/neotest-vitest",
      "nvim-neotest/neotest-go",
      "nvim-neotest/neotest-python",
    },
    opts = {
      adapters = {
        ["neotest-vitest"] = {},
        ["neotest-go"] = {},
        ["neotest-python"] = {},
      },
    },
  },
}
