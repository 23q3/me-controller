return function(Core)
    local Bridge = {}

    local readSerialized = Core.readSerialized
    local writeSerialized = Core.writeSerialized

    local function computerId()
        if os.getComputerID then return os.getComputerID() end
        if os.computerID then return os.computerID() end
        return "0"
    end

    local function jsonEncode(value)
        local encoder = textutils.serializeJSON or textutils.serialiseJSON
        if not encoder then error("JSON support is not available") end
        return encoder(value)
    end

    local function jsonDecode(value)
        local decoder = textutils.unserializeJSON or textutils.unserialiseJSON
        if not decoder then error("JSON support is not available") end
        return decoder(value)
    end

    local function defaultConfig()
        return {
            enabled = false,
            url = "",
            clientId = "cc-" .. tostring(computerId()),
            heartbeatSeconds = Core.CONFIG.bridgeHeartbeatSeconds,
            reconnectSeconds = Core.CONFIG.bridgeReconnectSeconds,
            receiveTimeoutSeconds = Core.CONFIG.bridgeReceiveTimeoutSeconds,
            commandLimit = 20,
            includeStock = false,
        }
    end

    local function normalizeConfig(raw)
        local config = defaultConfig()
        if type(raw) == "table" then
            for key, value in pairs(raw) do config[key] = value end
        end

        config.enabled = config.enabled == true
        config.url = tostring(config.url or "")
        config.clientId = tostring(config.clientId or ("cc-" .. tostring(computerId())))
        config.heartbeatSeconds = math.max(1, tonumber(config.heartbeatSeconds) or Core.CONFIG.bridgeHeartbeatSeconds)
        config.reconnectSeconds = math.max(1, tonumber(config.reconnectSeconds) or Core.CONFIG.bridgeReconnectSeconds)
        config.receiveTimeoutSeconds = math.max(0.05, tonumber(config.receiveTimeoutSeconds) or Core.CONFIG.bridgeReceiveTimeoutSeconds)
        config.commandLimit = math.max(1, math.floor(tonumber(config.commandLimit) or 20))
        config.includeStock = config.includeStock == true
        return config
    end

    function Bridge.loadConfig()
        return normalizeConfig(readSerialized(Core.CONFIG.bridgeFile))
    end

    function Bridge.saveConfig(config)
        return writeSerialized(Core.CONFIG.bridgeFile, normalizeConfig(config))
    end

    function Bridge.configure(url, enabled)
        local config = Bridge.loadConfig()
        if url ~= nil then config.url = tostring(url) end
        if enabled ~= nil then config.enabled = enabled == true end
        Bridge.saveConfig(config)
        return Bridge.loadConfig()
    end

    local function send(socket, envelope)
        local payload = jsonEncode(envelope)
        socket.send(payload)
        return true
    end

    local function snapshotEnvelope(runtime, config, eventType)
        return {
            type = eventType or "snapshot",
            clientId = config.clientId,
            time = Core.now(),
            snapshot = Core.makeSnapshot(runtime, {
                commandLimit = config.commandLimit,
                includeStock = config.includeStock,
            }),
        }
    end

    local function commandFromEnvelope(envelope)
        if type(envelope) ~= "table" then return nil end
        if envelope.type == "command" and type(envelope.command) == "table" then
            local command = envelope.command
            command.commandId = command.commandId or envelope.commandId or envelope.id
            return command
        end
        return envelope
    end

    -- Core.commandIdOf 相比旧私有版会 tostring 并把空串规整为 nil
    local commandIdOf = Core.commandIdOf

    local function sendCommandResult(socket, config, command, ok, response)
        return send(socket, {
            type = "command_result",
            clientId = config.clientId,
            time = Core.now(),
            commandId = commandIdOf(command),
            ok = ok,
            response = response,
        })
    end

    local function handleMessage(runtime, socket, config, text)
        local ok, envelope = pcall(jsonDecode, text)
        if not ok or type(envelope) ~= "table" then
            send(socket, {
                type = "error",
                clientId = config.clientId,
                time = Core.now(),
                error = "invalid_json",
            })
            return
        end

        local command = commandFromEnvelope(envelope)
        local commandOk, response, dirty = Core.applyCommand(runtime, command)
        if dirty then Core.saveState(runtime.state) end
        sendCommandResult(socket, config, command, commandOk, response)
        send(socket, snapshotEnvelope(runtime, config, "snapshot"))
    end

    local function receive(socket, timeout)
        local ok, message = pcall(function()
            return socket.receive(timeout)
        end)
        if not ok then error(message) end
        return message
    end

    local function connect(url)
        if not http or not http.websocket then error("http.websocket is not available") end
        local socket, err = http.websocket(url)
        if not socket then error(err or "websocket open failed") end
        return socket
    end

    local function runConnection(runtime, config)
        local socket = connect(config.url)
        runtime.bridge = {
            enabled = true,
            connected = true,
            url = config.url,
            clientId = config.clientId,
            connectedAt = Core.now(),
        }

        Core.logEvent(runtime, "INFO", "bridge_connected", {
            url = config.url,
            clientId = config.clientId,
        })

        send(socket, {
            type = "hello",
            clientId = config.clientId,
            time = Core.now(),
            protocol = "me_controller.bridge.v1",
        })
        send(socket, snapshotEnvelope(runtime, config, "snapshot"))

        local nextHeartbeatAt = 0
        while runtime.running do
            local now = Core.nowSeconds()
            if now >= nextHeartbeatAt then
                send(socket, snapshotEnvelope(runtime, config, "heartbeat"))
                nextHeartbeatAt = now + config.heartbeatSeconds
            end

            local message = receive(socket, config.receiveTimeoutSeconds)
            if message then handleMessage(runtime, socket, config, message) end
        end

        pcall(function() socket.close() end)
    end

    function Bridge.run(runtime)
        local idleLogged = false

        while runtime.running do
            local config = Bridge.loadConfig()
            if not config.enabled or config.url == "" then
                runtime.bridge = {
                    enabled = false,
                    connected = false,
                    url = config.url,
                    clientId = config.clientId,
                }
                if not idleLogged then
                    Core.logEvent(runtime, "INFO", "bridge_disabled", {})
                    idleLogged = true
                end
                sleep(1)
            else
                idleLogged = false
                local ok, err = pcall(function()
                    runConnection(runtime, config)
                end)

                runtime.bridge = {
                    enabled = true,
                    connected = false,
                    url = config.url,
                    clientId = config.clientId,
                    error = ok and nil or tostring(err),
                    disconnectedAt = Core.now(),
                }

                if runtime.running then
                    Core.logEvent(runtime, ok and "INFO" or "ERROR", "bridge_disconnected", {
                        url = config.url,
                        error = ok and nil or tostring(err),
                    })
                    sleep(config.reconnectSeconds)
                end
            end
        end
    end

    return Bridge
end
