# UF02 VPN Tether (WiFi Uplink → WireGuard → USB)

Turns the UF02 dongle into a plug-and-play VPN tether:

- Connects to a configured WiFi as its **uplink** (e.g. a phone hotspot).
- Forces **all traffic from the USB-connected PC** through WireGuard.
- PC gets internet automatically over USB (DHCP), and `http://192.168.1.1` stays reachable to change the WiFi.
- No policy routing is used (this kernel has `CONFIG_IP_ADVANCED_ROUTER` disabled — `ip rule` does not work), so the dongle uses a single default route via `wg0`.

## Prerequisites

- OpenWrt flashed (this repo's UF02 image).
- A WireGuard client config (e.g. from PiVPN). You need:
  - `PrivateKey`
  - `Address` (e.g. `10.55.185.5/24`)
  - peer `PublicKey`
  - peer `PresharedKey` (if used)
  - `Endpoint` host:port
- SSH access to the dongle.

> **Important:** use a peer that is **not** also in use by another device. If two devices share the same WireGuard key/address, they fight over the server endpoint and connectivity drops.

## 1. USB gadget: NCM

NCM auto-configures on Linux and on the Windows used for testing. (RNDIS did **not** enumerate on that Windows.)

```
uci set usbgadget.usb.enabled='1'
uci set usbgadget.ncm.enabled='1'
uci set usbgadget.rndis.enabled='0'
uci set usbgadget.ecm.enabled='0'
uci commit usbgadget
/etc/init.d/usb-gadget restart
```

The USB interface is added to the LAN bridge automatically.

## 2. WiFi uplink (STA)

The dongle acts as a WiFi **client** to your uplink. The AP interface is left disabled (only one radio; AP+STA on the same 2.4 GHz radio is unreliable).

```
uci set wireless.radio0.disabled='0'

# STA to the uplink
uci -q delete wireless.wan_sta
uci set wireless.wan_sta=wifi-iface
uci set wireless.wan_sta.device='radio0'
uci set wireless.wan_sta.mode='sta'
uci set wireless.wan_sta.network='wwan'
uci set wireless.wan_sta.ssid='note10pro'
uci set wireless.wan_sta.encryption='psk2'
uci set wireless.wan_sta.key='<WIFI_PASSWORD>'

# keep the AP defined but disabled
uci set wireless.default_radio0=wifi-iface
uci set wireless.default_radio0.device='radio0'
uci set wireless.default_radio0.mode='ap'
uci set wireless.default_radio0.network='lan'
uci set wireless.default_radio0.ssid='OpenWrt'
uci set wireless.default_radio0.encryption='none'
uci set wireless.default_radio0.disabled='1'

uci commit wireless
```

## 3. Network + WireGuard client

Edit `/etc/config/network` so it contains (keep the existing `loopback`, `globals`, `device br-lan`, `lan` and `modem` sections):

```
config interface 'wwan'
	option proto 'dhcp'

config interface 'wg0'
	option proto 'wireguard'
	option private_key '<WG_PRIVATE_KEY>'
	list addresses '<WG_ADDRESS>'
	option auto '0'

config wireguard_wg0 'peer'
	option public_key '<SERVER_PUBLIC_KEY>'
	option preshared_key '<WG_PRESHARED_KEY>'
	option endpoint_host '<ENDPOINT_HOST>'
	option endpoint_port '<ENDPOINT_PORT>'
	list allowed_ips '0.0.0.0/0'
	option persistent_keepalive '25'
	option route_allowed_ips '1'
```

`option auto '0'` is deliberate: WireGuard must **not** start until the clock is correct (see step 5).

Commit:

```
uci commit network
```

### DNS: force the endpoint to resolve to IPv4

Some uplinks (phone hotspots) use DNS64 and return a NAT64 AAAA address for the endpoint hostname. `wg` may then prefer that IPv6 address and fail to reach the server. Disable AAAA answers from the dongle's resolver:

```
uci set dhcp.@dnsmasq[0].filter_aaaa='1'
uci commit dhcp
/etc/init.d/dnsmasq restart
```

## 4. Firewall

The PC's traffic must only ever leave via the VPN: put the WiFi uplink + modem in the WAN zone, create a VPN zone for `wg0`, allow only `lan → vpn`, and remove the stock `lan → wan` forwarding.

> The stock `lan`/`wan` zones are anonymous (`@zone[0]`, `@zone[1]`). Verify with `uci show firewall` before running these.

```
# 1) The physical uplink (wifi + modem) belongs to the existing WAN zone
uci add_list firewall.@zone[1].network='wwan'
uci add_list firewall.@zone[1].network='modem'

# 2) VPN zone for wg0
uci -q delete firewall.vpn
uci set firewall.vpn=zone
uci set firewall.vpn.name='vpn'
uci set firewall.vpn.network='wg0'
uci set firewall.vpn.input='ACCEPT'
uci set firewall.vpn.output='ACCEPT'
uci set firewall.vpn.forward='ACCEPT'
uci set firewall.vpn.masq='1'
uci set firewall.vpn.mtu_fix='1'

# 3) Allow only lan -> vpn (kill switch)
uci -q delete firewall.lan_to_vpn
uci set firewall.lan_to_vpn=forwarding
uci set firewall.lan_to_vpn.src='lan'
uci set firewall.lan_to_vpn.dest='vpn'

# 4) Remove the stock lan -> wan forwarding
#    Find its index first:  uci show firewall | grep forwarding
uci -q delete firewall.@forwarding[0]

uci commit firewall
/etc/init.d/firewall restart
```

Expected result:

```
# lan  = br-lan (192.168.1.1)     input ACCEPT
# vpn  = wg0                       masq, forward ACCEPT
# wan  = wwan + modem              masq
# forwarding: lan -> vpn   (and NO lan -> wan)
```

## 5. Critical: resync the clock on every WiFi connect, before starting WireGuard

The dongle has **no usable RTC** (`hwclock -w` fails with `RTC_SET_TIME: No such device`), so on boot the clock may be stale or 1970 until NTP syncs.

WireGuard's replay protection means the server **silently drops handshakes whose timestamp is older than what it has stored for that peer**. A wrong clock therefore makes the tunnel never come up.

There is a second trap: once `wg0` is up, its `0.0.0.0/0` route takes over the dongle's own traffic (this kernel has no policy routing), so NTP could no longer reach the internet to fix the clock.

Fix, applied on **every** uplink connect (not just boot):
1. release `wg0`,
2. keep a direct default route via the WiFi uplink (metric 200 fallback),
3. force an NTP sync,
4. then start `wg0`.

Enable the NTP client:

```
uci set system.ntp.enabled='1'
uci commit system
/etc/init.d/sysntpd enable
/etc/init.d/sysntpd restart
```

Create `/etc/hotplug.d/iface/99-vpn-after-ntp`:

```sh
#!/bin/sh
[ "$ACTION" = "ifup" ] || [ "$ACTION" = "ifdown" ] || exit 0
[ "$INTERFACE" = "wwan" ] || exit 0

if [ "$ACTION" = "ifup" ]; then
	(
		ifdown wg0 2>/dev/null
		sleep 2

		gw=$(ubus call network.interface.wwan status 2>/dev/null | jsonfilter -e '@.route[0].nexthop' 2>/dev/null)
		[ -n "$gw" ] && ip route replace default via "$gw" dev phy0-sta0 metric 200 2>/dev/null

		/usr/sbin/ntpd -n -q \
			-p 0.openwrt.pool.ntp.org -p 1.openwrt.pool.ntp.org \
			-p 2.openwrt.pool.ntp.org -p 3.openwrt.pool.ntp.org \
			>/dev/null 2>&1

		ifup wg0
	) &
else
	ifdown wg0
	ip route del default metric 200 2>/dev/null
fi
```

Create `/etc/hotplug.d/ntp/30-vpn-start` (belt-and-braces trigger when NTP validates):

```sh
#!/bin/sh
[ "$ACTION" = "stratum" ] || exit 0
if ! ubus call network.interface.wg0 status 2>/dev/null | grep -q '"up": true'; then
  ifup wg0
fi
```

Make them executable:

```
chmod +x /etc/hotplug.d/iface/99-vpn-after-ntp /etc/hotplug.d/ntp/30-vpn-start
```

## 6. Reboot and verify

```
reboot
```

After boot, once the uplink connects:

```
date -u                                  # correct year (not 1970)
iw dev phy0-sta0 link | head -2          # connected to the uplink
wg show                                  # latest handshake + transfer
ip route show default                    # default dev wg0
```

The PC should now get an IP over USB and route through the VPN. Verify from the PC that the public IP is the VPN server's, and that `http://192.168.1.1` (LuCI) is reachable.

## 7. Recovery: entering EDL

If the dongle is unresponsive over USB (e.g. `device descriptor read/64, error -71`, so neither the gadget, fastboot, nor EDL enumerate), use the hardware force-EDL strap:

1. Short the USB **D+ (DP)** pad to **GND**.
2. While shorted, plug in USB to apply power.
3. Release once powered — the boot ROM enters **EDL**.

Confirm on the host:

```
lsusb | grep -i 05c6        # must show 05c6:9008 (Qualcomm QDL/EDL)
```

Then use the EDL tool:

```
sudo edl printgpt           # sanity check (reads partition table)
sudo edl reset              # exit EDL / reboot (or just replug)
```

Notes:

- The project README's "insert while holding the button" method does **not** work on every UF02 board; shorting **D+ to GND** during power-up is the reliable strap (this is how it was entered on this unit).
- This is OS-independent (primary boot ROM), so it works even if OpenWrt is not booting.
- Keep the factory `backup.bin` around — with EDL working you can always restore the original firmware.

## Behavior notes

- **Kill switch:** if WireGuard is down/never starts, the PC has no internet (only `lan → vpn` is forwarded).
- The dongle's own traffic uses the same `wg0` default once up (this kernel cannot split routing).
- To change the uplink WiFi, open LuCI at `http://192.168.1.1` and edit `wan_sta`.
