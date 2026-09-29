'use strict';
'require view';
'require uci';
'require fs';
'require ui';

function parseWg(text) {
	var iface = {}, peer = {};
	var cur = '';

	text.split(/\r?\n/).forEach(function(raw) {
		var line = raw.replace(/[#;].*$/, '').trim();
		if (!line)
			return;

		var sec = line.match(/^\[\s*([^\]]+?)\s*\]$/);
		if (sec) {
			cur = sec[1].toLowerCase();
			return;
		}

		var kv = line.match(/^([^=]+?)\s*=\s*(.*)$/);
		if (!kv)
			return;

		var k = kv[1].trim().toLowerCase();
		var v = kv[2].trim();

		if (cur === 'interface')
			iface[k] = v;
		else if (cur === 'peer')
			peer[k] = v;
	});

	return { iface: iface, peer: peer };
}

function splitList(v) {
	return (v || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
}

function listify(v) {
	if (v == null)
		return [];
	if (Array.isArray(v))
		return v.map(function(s) { return String(s).trim(); }).filter(Boolean);
	return splitList(String(v));
}

function currentWgConf() {
	var priv  = uci.get('network', 'wg0', 'private_key') || '';
	var addrs = listify(uci.get('network', 'wg0', 'addresses'));
	var dns   = listify(uci.get('dhcp', '@dnsmasq[0]', 'server'));
	var pub   = uci.get('network', 'peer', 'public_key') || '';
	var psk   = uci.get('network', 'peer', 'preshared_key') || '';
	var eh    = uci.get('network', 'peer', 'endpoint_host') || '';
	var ep    = uci.get('network', 'peer', 'endpoint_port') || '';
	var aips  = listify(uci.get('network', 'peer', 'allowed_ips'));

	if (!priv && !pub && !eh)
		return '';

	var L = [ '[Interface]' ];
	if (priv) L.push('PrivateKey = ' + priv);
	if (addrs.length) L.push('Address = ' + addrs.join(', '));
	if (dns.length) L.push('DNS = ' + dns.join(', '));
	L.push('');
	L.push('[Peer]');
	if (pub) L.push('PublicKey = ' + pub);
	if (psk) L.push('PresharedKey = ' + psk);
	if (eh) L.push('Endpoint = ' + eh + (ep ? ':' + ep : ''));
	if (aips.length) L.push('AllowedIPs = ' + aips.join(', '));

	return L.join('\n');
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('network'),
			uci.load('wireless'),
			uci.load('dhcp')
		]);
	},

	render: function() {
		var ssid = uci.get('wireless', 'wan_sta', 'ssid') || '';
		var key  = uci.get('wireless', 'wan_sta', 'key') || '';

		var inSsid = E('input', { type: 'text', value: ssid, style: 'width:100%' });
		var inKey  = E('input', { type: 'text', value: key, style: 'width:100%' });
		var inWg   = E('textarea', {
			rows: 12,
			style: 'width:100%;font-family:monospace',
			placeholder: '[Interface]\nPrivateKey = ...\nAddress = 10.55.185.5/24\nDNS = 10.55.185.1\n\n[Peer]\nPublicKey = ...\nPresharedKey = ...\nEndpoint = host.example:51820\nAllowedIPs = 0.0.0.0/0'
		});
		inWg.value = currentWgConf();

		function apply() {
			var s = inSsid.value.trim();
			var p = inKey.value;
			var wgText = inWg.value;

			if (!s) {
				ui.addNotification(null, E('p', _('WiFi SSID is required.')), 'error');
				return;
			}

			uci.set('wireless', 'wan_sta', 'ssid', s);
			uci.set('wireless', 'wan_sta', 'key', p);
			uci.set('wireless', 'wan_sta', 'encryption', 'psk2');
			uci.set('wireless', 'wan_sta', 'disabled', '0');

			if (wgText.trim()) {
				var wg = parseWg(wgText);
				var i = wg.iface, pe = wg.peer;

				uci.set('network', 'wg0', 'proto', 'wireguard');
				uci.set('network', 'wg0', 'auto', '0');
				if (i.privatekey)
					uci.set('network', 'wg0', 'private_key', i.privatekey);

				var addrs = splitList(i.address);
				if (addrs.length)
					uci.set('network', 'wg0', 'addresses', addrs);

				if (pe.publickey)
					uci.set('network', 'peer', 'public_key', pe.publickey);
				if (pe.presharedkey)
					uci.set('network', 'peer', 'preshared_key', pe.presharedkey);

				if (pe.endpoint) {
					var ep = pe.endpoint, host = ep, port = '51820';
					var m = ep.match(/^\[([^\]]+)\]:(\d+)$/);
					if (m) {
						host = m[1];
						port = m[2];
					}
					else {
						var c = ep.lastIndexOf(':');
						if (c > 0) {
							host = ep.substring(0, c);
							port = ep.substring(c + 1);
						}
					}
					uci.set('network', 'peer', 'endpoint_host', host);
					uci.set('network', 'peer', 'endpoint_port', port);
				}

				var aips = splitList(pe.allowedips);
				uci.set('network', 'peer', 'allowed_ips', aips.length ? aips : ['0.0.0.0/0']);
				uci.set('network', 'peer', 'route_allowed_ips', '1');
				uci.set('network', 'peer', 'persistent_keepalive', '25');

				var dns = splitList(i.dns);
				if (dns.length)
					uci.set('dhcp', '@dnsmasq[0]', 'server', dns);
			}

			ui.showModal(_('Applying'), [ E('p', { class: 'spinning' }, _('Reconnecting WiFi and starting WireGuard...')) ]);

			return uci.save()
				.then(function() { return uci.apply(); })
				.then(function() { return fs.exec('/sbin/wifi', ['reload']); })
				.then(function() { return fs.exec('/bin/sh', ['-c', 'sleep 6; /sbin/ifup wg0']); })
				.then(function() {
					ui.hideModal();
					ui.addNotification(null, E('p', _('Saved. The dongle is reconnecting to the WiFi and starting WireGuard.')), 'info');
				})
				.catch(function(e) {
					ui.hideModal();
					ui.addNotification(null, E('p', _('Error: %s').format(e)), 'error');
				});
		}

		return E('div', { class: 'cbi-map' }, [
			E('h2', {}, _('VPN Tether')),
			E('p', {}, _('Pick the WiFi to use as the uplink, then paste a WireGuard client config. All traffic from the USB-connected PC will be routed through the tunnel.')),

			E('div', { class: 'cbi-section' }, [
				E('div', { class: 'cbi-value' }, [
					E('label', { class: 'cbi-value-title' }, _('WiFi SSID')),
					E('div', { class: 'cbi-value-field' }, inSsid)
				]),
				E('div', { class: 'cbi-value' }, [
					E('label', { class: 'cbi-value-title' }, _('WiFi Password')),
					E('div', { class: 'cbi-value-field' }, inKey)
				]),
				E('div', { class: 'cbi-value' }, [
					E('label', { class: 'cbi-value-title' }, _('WireGuard config')),
					E('div', { class: 'cbi-value-field' }, inWg)
				])
			]),

			E('div', { class: 'cbi-page-actions' }, [
				E('button', {
					class: 'btn cbi-button cbi-button-apply',
					click: function(ev) { ev.preventDefault(); return apply(); }
				}, _('Apply'))
			])
		]);
	},

	handleSave: null,
	handleSaveApply: null
});
