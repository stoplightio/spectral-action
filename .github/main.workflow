workflow "Build Pipeline" {
  on = "push"
  resolves = ["Spectral checks"]
}

action "Spectral checks" {
  uses = "./"
  secrets = ["GITHUB_TOKEN"]
  env = {
    SPECTRAL_FILE_PATH = "test.oas.json"
  }
}
