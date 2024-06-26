import dgram from 'dgram';
import crypto from './crypto';
import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic, Categories } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, UDP_SCAN_PORT, DEFAULT_DEVICE_CONFIG } from './settings';
import { GreeAirConditioner } from './platformAccessory';
import { GreeAirConditionerTS } from './tsAccessory';

/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class GreeACPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // this is used to track restored cached accessories
  private devices: Record<string, PlatformAccessory>;
  private initializedDevices: Record<string, boolean>;
  private skippedDevices: Record<string, boolean>;
  private socket: dgram.Socket;
  private timer: NodeJS.Timeout | undefined;
  private scanCount: number;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.socket = dgram.createSocket({type: 'udp4', reuseAddr: true});
    this.devices = {};
    this.initializedDevices = {};
    this.skippedDevices = {};
    this.scanCount = 0;
    this.log.debug('Finished initializing platform:', this.config.name);

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      this.socket.on('message', this.handleMessage);
      // run the method to discover / register your devices as accessories
      this.discoverDevices();
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.debug('Loading accessory from cache: ', accessory.displayName, accessory.context.device);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    if (accessory.context.device?.mac) {
      if (accessory.context.deviceType === undefined || accessory.context.deviceType === 'HeaterCooler') {
        // this is the main accessory
        this.devices[accessory.context.device.mac] = accessory;
      }
      if (accessory.context.deviceType === 'TemperatureSensor') {
        // this is the temperature sensor
        this.devices[accessory.context.device.mac + '_ts'] = accessory;
      }
    }
  }

  /**
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  discoverDevices() {
    if (this.config.port !== undefined && typeof this.config.port === 'number' && this.config.port === this.config.port &&
      this.config.port >= 0 && this.config.port <= 65535) {
      this.socket.bind(this.config.port, () => {
        this.log.info(`UDP server bind to port ${this.config.port}`);
        this.socket.setBroadcast(true);
        this.timer = setInterval(() => {
          this.scanCount += 1;
          if (this.scanCount > this.config.scanCount && this.timer) {
            this.log.info('Scan finished.');
            clearInterval(this.timer);
            this.socket.close();
            // remove accessories not found on network
            Object.entries(this.devices).forEach(([key, value]) => {
              if (!this.initializedDevices[value.UUID]) {
                this.log.debug('Cleanup -> Remove', value.displayName, key, value.UUID);
                delete this.config.devices[key];
              }
            });
          } else {
            this.broadcastScan();
          }
        }, this.config.scanTimeout * 1000); // scanTimeout in seconds
      });
    } else {
      this.log.warn('Warning: Port is missing or misconfigured');
    }
  }

  handleMessage = (msg, rinfo) => {
    this.log.debug('handleMessage', msg.toString());
    try {
      const message = JSON.parse(msg.toString());
      if (message.i !== 1 || message.t !== 'pack') {
        this.log.debug('handleMessage - unknown response');
        return;
      }
      const pack = crypto.decrypt(message.pack);
      this.log.debug('handleMessage - Package -> %j', pack);
      if (pack.t === 'dev') {
        this.registerDevice({
          ...pack,
          address: rinfo.address,
          port: rinfo.port,
        });
      }
    } catch (err) {
      this.log.error('handleMessage', err);
    }
  };

  registerDevice = (deviceInfo) => {
    const devcfg = this.config.devices.find((item) => item.mac === deviceInfo.mac) || {};
    const deviceConfig = {
      ...devcfg,
      ...((devcfg.speedSteps && devcfg.speedSteps !== 3 && devcfg.speedSteps !== 5) || devcfg.speedSteps === 0 ?
        {speedSteps: 5} : {}),
      ...((devcfg.temperatureSensor && ['disabled', 'child', 'separate'].includes((devcfg.temperatureSensor as string).toLowerCase())) ?
        {temperatureSensor: (devcfg.temperatureSensor as string).toLowerCase()} : {temperatureSensor: 'disabled'}),
      ...(devcfg.minimumTargetTemperature && (devcfg.minimumTargetTemperature < DEFAULT_DEVICE_CONFIG.minimumTargetTemperature ||
        devcfg.minimumTargetTemperature > DEFAULT_DEVICE_CONFIG.maximumTargetTemperature) ?
        { minimumTargetTemperature: DEFAULT_DEVICE_CONFIG.minimumTargetTemperature } : {}),
      ...(devcfg.maximumTargetTemperature && (devcfg.maximumTargetTemperature < DEFAULT_DEVICE_CONFIG.minimumTargetTemperature ||
        devcfg.maximumTargetTemperature > DEFAULT_DEVICE_CONFIG.maximumTargetTemperature) ?
        { maximumTargetTemperature: DEFAULT_DEVICE_CONFIG.maximumTargetTemperature } : {}),
    };
    Object.entries(DEFAULT_DEVICE_CONFIG).forEach(([key, value]) => {
      if (deviceConfig[key] === undefined) {
        deviceConfig[key] = value;
      }
    });
    let accessory = this.devices[deviceInfo.mac];
    let accessory_ts = this.devices[deviceInfo.mac + '_ts'];

    if (deviceConfig?.disabled || !/^[a-f0-9]{12}$/.test(deviceConfig.mac)) {
      if (!this.skippedDevices[deviceInfo.mac]) {
        this.log.info(`accessory ${deviceInfo.mac} skipped`);
        this.skippedDevices[deviceInfo.mac] = true;
      }
      if (accessory) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        delete this.devices[deviceConfig.mac];
      }
      if (accessory_ts) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory_ts]);
        delete this.devices[deviceConfig.mac + '_ts'];
      }
      return;
    }

    if (accessory && this.initializedDevices[accessory.UUID]) {
      // already initalized
      return;
    }

    if (!accessory) {
      const deviceName = deviceConfig?.name ?? (deviceInfo.name || deviceInfo.mac);
      this.log.debug(`Initializing new accessory ${deviceInfo.mac} with name ${deviceName}...`);
      const uuid = this.api.hap.uuid.generate(deviceInfo.mac);
      accessory = new this.api.platformAccessory(deviceName, uuid, Categories.AIR_CONDITIONER);

      this.devices[deviceInfo.mac] = accessory;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    if (!accessory_ts && deviceConfig.temperatureSensor === 'separate') {
      const deviceName_ts = 'Temperature Sensor - ' + (deviceConfig?.name ?? (deviceInfo.name || deviceInfo.mac));
      this.log.debug(`Initializing new accessory ${deviceInfo.mac} with name ${deviceName_ts}...`);
      const uuid = this.api.hap.uuid.generate(deviceInfo.mac + '_ts');
      accessory_ts = new this.api.platformAccessory(deviceName_ts, uuid, Categories.SENSOR);

      this.devices[deviceInfo.mac + '_ts'] = accessory_ts;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory_ts]);
    }

    if (accessory_ts && deviceConfig.temperatureSensor !== 'separate') {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory_ts]);
      delete this.devices[deviceConfig.mac + '_ts'];
    }

    let tsService;
    if (accessory_ts && deviceConfig.temperatureSensor === 'separate') {
      // mark temperature sensor devices as initialized
      accessory_ts.context.device = deviceInfo;
      accessory_ts.context.deviceType = 'TemperatureSensor';
      this.initializedDevices[accessory_ts.UUID] = true;
      tsService = new GreeAirConditionerTS(this, accessory_ts, deviceConfig);
    }

    if (accessory) {
      // mark devices as initialized
      accessory.context.device = deviceInfo;
      accessory.context.deviceType = 'HeaterCooler';
      this.initializedDevices[accessory.UUID] = true;
      return new GreeAirConditioner(this, accessory, deviceConfig, this.config.port as number, tsService);
    }
  };

  broadcastScan() {
    const message = Buffer.from(JSON.stringify({ t: 'scan' }));
    this.socket.send(message, 0, message.length, UDP_SCAN_PORT, this.config.scanAddress, (error) => {
      this.log.debug(`Broadcast '${message}' ${this.config.scanAddress}:${UDP_SCAN_PORT}`);
      if (error) {
        this.log.error('broadcastScan', error.message);
      }
    });
  }
}
