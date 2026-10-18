import { mascot } from "../src/mascot.js"

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")

console.log("=== OPEN ===")
console.log(strip(mascot({ say: "hola" })))
console.log("\n=== GLITCH ===")
console.log(strip(mascot({ glitch: 7, say: "connected" })))
