local function runAgent()
    shell.run("agent")
end

local function runMeController()
    shell.run("me_controller")
end

term.clear()
term.setCursorPos(1, 1)
print("Starting CC services...")
print("- agent")
print("- me_controller")
print("")
print("Hold Ctrl+T to terminate this supervisor.")

parallel.waitForAny(runAgent, runMeController)
