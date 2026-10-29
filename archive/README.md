# archive

The first version of the WayPoint firmware, kept for reference. It is not
used or maintained. The current firmware is in `../firmware/waypoint/`.

| What | Why it might still be useful |
|------|------------------------------|
| `localizer/` | Old main firmware. Also streamed MPU6050 data over serial, searched the subnet for the API when the laptop's IP changed, and had per-panel OLED driver options. |
| `hw_check/` | Bench test: LED colour cycle, I2C scan, MPU6050 readout, and a cycle through 6 OLED driver modes. Use it if the display shows garbage. |
| `serial_logger.py` + `requirements.txt` | Recorded the old firmware's serial output (IMU + scans) for the navigation dataset. Only works with `localizer/`. |
