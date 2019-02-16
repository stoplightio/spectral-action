workflow "New workflow" {
  on = "push"
  resolves = ["Spectral checks"]
}

action "Spectral checks" {
  uses = "./"
}
