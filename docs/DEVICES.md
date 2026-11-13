# Tracker set-up

Trackers are provisioned by Jatelo (**Super admin → Tracker stock → Provision trackers**, IMEI per line), then the company
assigns each one to a vehicle (**Vehicles → vehicle → Tracker & driver**). Unknown IMEIs are rejected by the gateway.

| Protocol | Models tested | Server port | Notes |
| --- | --- | --- | --- |
| Teltonika Codec 8 / 8E / 12 | FMB920, FMB130, FMC130, FMC920, FMB125 | 5027 | Best data: CAN fuel/odometer, harsh events, RFID, DTCs, immobiliser |
| GT06 / Concox | GT06N, JM-VL01, WeTrack, AT4 | 5023 | Location, ACC, alarms, relay (engine cut) |
| Queclink | GV300, GV350, GV55 | 5004 | ASCII `+RESP` reports, ignition events, buffered history |
| Phone (driver app) | Android 8+ | HTTPS `gps.<domain>` | For vehicles without hardware; on shift only |

## SIM / APN

| Network | APN |
| --- | --- |
| Safaricom (KE) | `safaricom` (M2M SIMs: `safaricom.m2m` if issued) |
| Airtel KE / UG / TZ / RW | `internet` |
| Vodacom TZ | `internet` |
| MTN UG / RW | `internet` / `internet.mtn` |
| Tigo/Yas TZ | `internet` |

Disable the SIM PIN. Use data bundles that do not expire mid-month; a tracker uses 15–40 MB/month at the settings below.

## Teltonika (Configurator or SMS)

GPRS → Server: domain = your ingest host, port = 5027, protocol TCP, **Codec 8 Extended**, record ACK on.
Data acquisition (recommended): on stop 300 s; on moving 10 s or 100 m or 15°; send period 10 s when moving.
I/O: Ignition (239), Movement (240), External voltage (66), Total odometer (16, **set "calculation source: GNSS" or CAN**),
Green driving (253/254, thresholds 0.35 g brake, 0.30 g accel, 0.35 g corner), Overspeeding (255), Crash (247),
Towing (246), Jamming (249), Unplug (252), CAN fuel (84/89), RFID/iButton (207/78) if fitted.

SMS example (with SMS login/password empty):

```
  setparam 2004:gps.jatelofleet.com;2005:5027;2006:0
  setparam 2001:safaricom
```

Engine immobiliser: wire the relay to DOUT1; the platform sends `setdigout 1` / `setdigout 0` (Codec 12).

## Concox / GT06 (SMS)

```
APN,safaricom#
SERVER,1,gps.jatelofleet.com,5023,0#
TIMER,10,300#          (moving / parked upload interval, seconds)
GMT,E,3#               (time zone does not matter to the platform - it uses UTC from GPS)
RELAY,1#  /  RELAY,0#  (engine cut / restore - sent by the platform)
```

## Queclink (Manage Tool or AT commands)

`AT+GTBSI=gv300,safaricom,,,,,,,FFFF$` · `AT+GTSRI=gv300,3,,1,gps.jatelofleet.com,5004,,,0,0,0,0,,,,FFFF$` ·
fixed report `AT+GTFRI=gv300,1,1,,,0000,0000,,30,1000,1000,,0,0,0,0,FFFF$` (30 s), ignition reports on.

## Checking a new tracker

1. **Devices** list → the tracker shows *Online* within a minute of power-up.
2. **Live map** shows the vehicle; drive 1 km and confirm the trip appears in **Trips**.
3. Send **Get device info** from the Devices page and check the reply.

The gateway logs every rejected connection with the IMEI it presented; ask Jatelo support to check provisioning if a tracker
stays offline.
