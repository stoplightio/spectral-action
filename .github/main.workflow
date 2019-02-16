workflow "Build Pipeline" {
  on = "push"
  resolves = ["Spectral checks"]
}

action "Spectral checks" {
  uses = "./"
}
