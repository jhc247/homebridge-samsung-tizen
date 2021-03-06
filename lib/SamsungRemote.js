let exec      = require('child_process').exec;
let WebSocket = require('ws');
let wol       = require('wake_on_lan');

module.exports = class SamsungRemote {
    /**
     * Constructor
     *
     * @param  {Object} device
     */
    constructor(device) {
        this.name       = device.config.name  || 'SamsungTvRemote';
        this.ip         = device.config.ip    || '192.168.1.0';
        this.mac        = device.config.mac   || '00:00:00:00';
        this.port       = device.config.port  || 8002;
        this.delay      = device.config.delay || 400;
        this.token      = device.config.token || null;

        this.sleep      = null;
        this.device     = device;
        this.remote     = `wss://${this.ip}:${this.port}/api/v2/channels/samsung.remote.control?name=${this._encodeName()}`;

        // Timers
        this.sleepMode  = null;
        this.turningOn  = null;
        this.turningOff = null;
    }

    /**
     * Check if TV is on
     *
     * @param  {Boolean} getRealStatus
     * @return {Boolean}
     */
    isOn(getRealStatus = false) {
        return new Promise(resolve => {
            if (this.turningOn !== null && !getRealStatus) { resolve(true); }
            if (this.turningOff !== null && !getRealStatus) { resolve(false); }
            if (this.sleepMode !== null && !getRealStatus) { resolve(false); }

            exec('ping -t 1 -c 1 -w 1 ' + this.ip, (error) => resolve(error ? false : true));
        });
    }

    /**
     * Turn ON the TV
     *
     * @return {Promise}
     */
    turnOn() {
        return new Promise(async (resolve, reject) => {
            let status = await this.isOn(true);

            // Check if TV is turning OFF
            if (this.turningOff !== null) {
                return reject('Powering OFF is in progress');
            }

            // Check if TV is already ON
            if (status && this.sleepMode === null) {
                return resolve('TV is already ON');
            }

            // Stop sleep mode
            clearTimeout(this.sleepMode);
            this.sleepMode = null;

            // TV is OFF but still takes commands
            if (status) {
                await this.sendCmd('KEY_POWER');

                this.turningOn = setTimeout(() => this.turningOn = null, 1000 * 3);

                return resolve('TV powered ON');
            }

            // TV is OFF and we need to use WOL
            wol.wake(this.mac, (error) => {
                if (error) {
                    return reject('Failed to power on TV');
                } else {
                    this.turningOn = setTimeout(() => this.turningOn = null, 1000 * 3);

                    return resolve('TV powered ON');
                }
            });
        });
    }

    /**
     * Turn OFF the TV
     *
     * @return {Promise}
     */
    turnOff() {
        return new Promise(async (resolve, reject) => {
            // Check if TV is turning ON
            if (this.turningOn !== null) {
                return reject('Powering ON is in progress');
            }

            // Check if TV is turning OFF
            if (this.sleepMode !== null) {
                return resolve('TV is already OFF');
            }

            // Check if TV is OFF
            let status = await this.isOn(true);

            if (!status) {
                // Debug
                this.device.debug(status);

                return resolve('TV is already OFF');
            }

            // Magic
            try {
                await this.sendCmd('KEY_POWER');

                this.turningOff = setTimeout(() => this.turningOff = null, 1000 * 3);
                this.sleepMode  = setTimeout(() => {
                    this.sleepMode = null;
                    this._closeSocket();
                }, 1000 * 15);

                resolve('TV powered OFF');
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Set a channel
     *
     * @param {Int} channel
     * @return {Promise}
     */
    setChannel(channel) {
        return new Promise(async (resolve, reject) => {
            // If we don't have a valid channel
            if (isNaN(parseInt(channel))) {
                return reject('Invalid channel number');
            }

            // Create commands
            let commands = [];
            for (let number of String(channel).split('')) { commands.push(`KEY_${number}`) }
            commands.push('KEY_ENTER');

            // Send the commands
            try {
                let response = await this.sendCmd(commands);

                resolve(`Changed to channel ${channel} with success`);
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Set sleep time
     *
     * @param {Number}   minutes
     * @param {Function} callback
     * @return {Promise}
     */
    setSleep(minutes, callback) {
        return new Promise(async (resolve, reject) => {
            // If we don't have a time
            if (this.sleep && !minutes ) {
                // Stop sleep
                clearTimeout(this.sleep);
                this.sleep = null;

                return resolve('Timer turned OFF');
            }

            // Check if TV is ON
            let status = await this.isOn();

            if (!status) {
                return reject('TV is already OFF');
            }

            // Start the countdown
            this.sleep = setTimeout(async () => {
                // Clear timer
                this.sleep = null;

                // Turn the TV OFF
                let response = await this.turnOff();

                // Run callback
                callback.call(null, response);
            }, 1000 * 60 * parseInt(minutes));

            // Set response message
            resolve(`Timer set to ${minutes} minutes`);
        });
    }

    /**
     * Send command to TV
     *
     * @param  {String/Array} commands
     * @return {Promise}
     */
    sendCmd(commands) {
        return new Promise(async (resolve, reject) => {
            // Transform to array
            if (!Array.isArray(commands)) { commands = [commands]; }

            // Get connection
            try {
                await this._connection();
            } catch (error) {
                return reject('Can\'t reach TV');
            }

            // Transform repetitive commands
            let commandSplit;

            commands = commands.map(command => {
                commandSplit = command.split('*');

                if (commandSplit[1]) { return Array(parseInt(commandSplit[1])).fill(commandSplit[0]); }

                return command;
            }).reduce((acc, val) => acc.concat(val), []);

            // Send first command
            try {
                await this._sendCmd(commands[0]);
            } catch (error) {
                return reject('Failed to send the command to TV');
            }

            // Send the next commands
            if (commands.length <= 1) {
                resolve('Command sent with success to TV');
            } else {
                let count = 1;
                let inter = setInterval(async () => {
                    // Send command
                    try {
                        await this._sendCmd(commands[count]);
                    } catch (error) {
                        return reject('Failed to send the command to TV');
                    }

                    count++;

                    // If it's the last command close the socket
                    if (count > commands.length - 1) {
                        clearInterval(inter);
                        resolve('Command sent with success to TV');
                    }
                }, this.delay);
            }
        });
    }

    /**
     * Private: Start WebSocket connection
     *
     * @return {Promise}
     */
    _connection() {
        return new Promise(async (resolve, reject) => {
            // Check if we already have a connection
            if (this.socket) {
                // Reset timeout
                clearTimeout(this.socket.timeout);
                this.socket.timeout = setTimeout(() => this._closeSocket(), 1000 * 60 * 2);

                return resolve();
            }

            // Debug
            this.device.debug(`Connect to ${this.remote}&token=${this.token}`);

            // Start connection
            this.socket = new WebSocket(`${this.remote}&token=${this.token}`, {
                rejectUnauthorized: false
            });

            // When the socket has an error
            this.socket.on('error', (error) => {
                // Debug
                this.device.debug(error);

                reject(error);
            });

            // When the socket is closed
            this.socket.on('close', () => {
                clearTimeout(this.socket.timeout);
                this.socket = null;
            });

            // When the socket is open
            this.socket.on('message', (data) => {
                data = JSON.parse(data);

                // Debug
                this.device.debug(data);

                // Green light
                if (data.event === 'ms.channel.connect') {
                    resolve();

                    // Close the socket in two minutes
                    this.socket.timeout = setTimeout(() => this._closeSocket(), 1000 * 60 * 2);
                } else {
                    reject();
                }
            });
        });
    }

    /**
     * Private: Send command to WebSocket
     *
     * @param  {String} command
     * @return {Promise}
     */
    _sendCmd(command) {
        return new Promise(async (resolve, reject) => {
            // Debug
            this.device.debug(`Send command ${command}`);

            this.socket.send(JSON.stringify({
                method: 'ms.remote.control',
                params: {
                    Cmd: 'Click',
                    DataOfCmd: command,
                    Option: false,
                    TypeOfRemote: 'SendRemoteKey'
                }
            }), (error) => {
                if (error) {
                    // Debug
                    this.device.debug(error);

                    reject(error)
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Provate: Close socket connection
     */
    _closeSocket() {
        // Check if socket is active
        if (this.socket) {
            this.socket.close();
        }
    }

    /**
     * Private: Pair the device and get token
     *
     * @return {Promise}
     */
    _pair() {
        return new Promise((resolve, reject) => {
            // Debug
            this.device.debug(`Pair to ${this.remote}`);

            // Start connection
            let socket = new WebSocket(this.remote, {
                rejectUnauthorized: false
            });

            // When the socket has an error
            socket.on('error', (error) => {
                this.device.debug(error);

                reject(error);
            });

            // When the socket is open
            socket.on('message', (response) => {
                let data = JSON.parse(response).data;

                // Debug
                this.device.debug(data);

                // Got the token
                if (data.token) {
                    // Save the token for current instance
                    this.token = data.token;

                    resolve(data.token);
                } else {
                    reject();
                }

                // Close socket
                socket.close();
            });
        });
    }

    /**
     * Get the TV Name encoded to base64
     *
     * @return {String}
     */
    _encodeName() {
        return new Buffer(this.name).toString('base64');
    }
}