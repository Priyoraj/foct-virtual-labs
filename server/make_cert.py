#!/usr/bin/env python3
"""
Create the lab's own certificate authority (CA) and an HTTPS certificate for
this server, so browsers treat FoCT Virtual Labs as a secure site.

    python server/make_cert.py                 # names/IPs of this PC
    python server/make_cert.py --name vlabs.adtu.local --ip 10.0.5.20

Files (server/certs/):
  foct-lab-ca.crt   public CA certificate - install it on every lab PC once
  foct-lab-ca.key   CA private key - keep it on this server, never share it
  server.crt/.key   HTTPS certificate, re-issued automatically when the IP changes

The CA is name-constrained: it can only vouch for private LAN addresses and
local host names, so even a leaked CA key cannot impersonate real websites.
Uses the `cryptography` package if installed, otherwise the `openssl` tool.
"""
import argparse
import datetime
import ipaddress
import os
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CERTS = HERE / "certs"
WEB = HERE.parent / "web"
CA_CRT, CA_KEY = CERTS / "foct-lab-ca.crt", CERTS / "foct-lab-ca.key"
SRV_CRT, SRV_KEY, SRV_NAMES = CERTS / "server.crt", CERTS / "server.key", CERTS / "server-names.txt"

PRIVATE_NETS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8", "169.254.0.0/16"]
LOCAL_DNS = ["localhost", "local", "lan", "internal", "home.arpa", "intranet"]
ORG = "Assam down town University"
UNIT = "Faculty of Computer Technology"


def ensure(ips, hostname, extra_names=(), extra_ips=()):
    """Create the CA if needed and a server certificate matching the current names/IPs."""
    CERTS.mkdir(exist_ok=True)
    names = sorted({n.lower() for n in ["localhost", hostname, hostname + ".local", *extra_names] if n})
    addrs = sorted({"127.0.0.1", *ips, *extra_ips})
    want = " ".join(names + addrs)
    if not (CA_CRT.exists() and CA_KEY.exists()):
        print("Creating the lab certificate authority ...")
        make_ca(sorted({hostname.lower(), *[n.lower() for n in extra_names]}))
    if (not SRV_CRT.exists() or not SRV_NAMES.exists()
            or SRV_NAMES.read_text().strip() != want or expiring(SRV_CRT)):
        print("Issuing the HTTPS certificate for:", want)
        make_server(names, addrs)
        SRV_NAMES.write_text(want)
    WEB.mkdir(exist_ok=True)
    (WEB / "foct-lab-ca.crt").write_bytes(CA_CRT.read_bytes())  # public part only
    return str(SRV_CRT), str(SRV_KEY)


def expiring(path):
    try:
        from cryptography import x509
        cert = x509.load_pem_x509_certificate(path.read_bytes())
        end = getattr(cert, "not_valid_after_utc", None) or cert.not_valid_after.replace(
            tzinfo=datetime.timezone.utc)
        return end - datetime.datetime.now(datetime.timezone.utc) < datetime.timedelta(days=30)
    except ImportError:
        return False
    except Exception:
        return True


def have_cryptography():
    try:
        import cryptography  # noqa: F401
        return True
    except ImportError:
        return False


# ------------------------------------------------------------ cryptography
def make_ca(dns_names):
    if not have_cryptography():
        return openssl_ca(dns_names)
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, f"FoCT Virtual Labs Local CA ({socket.gethostname()})"),
        x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, UNIT),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, ORG),
    ])
    permitted = [x509.IPAddress(ipaddress.ip_network(n)) for n in PRIVATE_NETS]
    permitted += [x509.DNSName(d) for d in sorted(set(LOCAL_DNS + list(dns_names)))]
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder()
            .subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=3650))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, key_cert_sign=True, crl_sign=True,
                                         content_commitment=False, key_encipherment=False,
                                         data_encipherment=False, key_agreement=False,
                                         encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.NameConstraints(permitted_subtrees=permitted, excluded_subtrees=None),
                           critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .sign(key, hashes.SHA256()))
    CA_KEY.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                         serialization.NoEncryption()))
    restrict(CA_KEY)
    CA_CRT.write_bytes(cert.public_bytes(serialization.Encoding.PEM))


def make_server(names, addrs):
    if not have_cryptography():
        return openssl_server(names, addrs)
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    ca_key = serialization.load_pem_private_key(CA_KEY.read_bytes(), password=None)
    ca = x509.load_pem_x509_certificate(CA_CRT.read_bytes())
    key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.datetime.now(datetime.timezone.utc)
    san = [x509.DNSName(n) for n in names] + [x509.IPAddress(ipaddress.ip_address(a)) for a in addrs]
    cert = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, names[0]),
                                     x509.NameAttribute(NameOID.ORGANIZATION_NAME, ORG)]))
            .issuer_name(ca.subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=800))
            .add_extension(x509.SubjectAlternativeName(san), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, key_encipherment=False, key_agreement=True,
                                         content_commitment=False, data_encipherment=False,
                                         key_cert_sign=False, crl_sign=False, encipher_only=False,
                                         decipher_only=False), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()),
                           critical=False)
            .sign(ca_key, hashes.SHA256()))
    SRV_KEY.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                          serialization.NoEncryption()))
    restrict(SRV_KEY)
    SRV_CRT.write_bytes(cert.public_bytes(serialization.Encoding.PEM))


# ------------------------------------------------------------ openssl fallback
def openssl():
    exe = shutil.which("openssl")
    if not exe and os.name == "nt":
        for p in (r"C:\Program Files\Git\usr\bin\openssl.exe", r"C:\Program Files\OpenSSL-Win64\bin\openssl.exe"):
            if os.path.exists(p):
                exe = p
    if not exe:
        sys.exit("Need either the Python 'cryptography' package (pip install cryptography) "
                 "or the 'openssl' program to create certificates.")
    return exe


def run_openssl(args, conf_text=None):
    with tempfile.TemporaryDirectory() as tmp:
        if conf_text:
            conf = Path(tmp) / "openssl.cnf"
            conf.write_text(conf_text)
            args = [a.replace("{conf}", str(conf)) for a in args]
        subprocess.run([openssl(), *args], check=True, capture_output=True)


def openssl_ca(dns_names):
    perm = ",".join([f"permitted;IP:{ipaddress.ip_network(n).network_address}/"
                     f"{ipaddress.ip_network(n).netmask}" for n in PRIVATE_NETS] +
                    [f"permitted;DNS:{d}" for d in sorted(set(LOCAL_DNS + list(dns_names)))])
    conf = f"""[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ca
[dn]
CN = FoCT Virtual Labs Local CA ({socket.gethostname()})
OU = {UNIT}
O = {ORG}
[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, digitalSignature, keyCertSign, cRLSign
nameConstraints = critical, {perm}
subjectKeyIdentifier = hash
"""
    run_openssl(["req", "-x509", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
                 "-nodes", "-keyout", str(CA_KEY), "-out", str(CA_CRT), "-days", "3650", "-sha256",
                 "-config", "{conf}"], conf)
    restrict(CA_KEY)


def openssl_server(names, addrs):
    san = ",".join([f"DNS:{n}" for n in names] + [f"IP:{a}" for a in addrs])
    conf = f"""[req]
distinguished_name = dn
prompt = no
[dn]
CN = {names[0]}
O = {ORG}
[ext]
subjectAltName = {san}
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyAgreement
extendedKeyUsage = serverAuth
authorityKeyIdentifier = keyid
"""
    with tempfile.TemporaryDirectory() as tmp:
        csr = Path(tmp) / "server.csr"
        run_openssl(["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
                     "-keyout", str(SRV_KEY), "-out", str(csr), "-config", "{conf}"], conf)
        run_openssl(["x509", "-req", "-in", str(csr), "-CA", str(CA_CRT), "-CAkey", str(CA_KEY),
                     "-CAcreateserial", "-out", str(SRV_CRT), "-days", "800", "-sha256",
                     "-extfile", "{conf}", "-extensions", "ext"], conf)
    restrict(SRV_KEY)


def restrict(path):
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def main():
    sys.path.insert(0, str(HERE))
    from serve import lan_addresses
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", action="append", default=[], help="extra DNS name for this server")
    ap.add_argument("--ip", action="append", default=[], help="extra IP address for this server")
    ap.add_argument("--new-ca", action="store_true", help="throw away the old CA and create a new one")
    args = ap.parse_args()
    if args.new_ca:
        for p in (CA_CRT, CA_KEY, SRV_CRT, SRV_KEY, SRV_NAMES):
            if p.exists():
                p.unlink()
    crt, key = ensure(lan_addresses(), socket.gethostname(), args.name, args.ip)
    print("HTTPS certificate:", crt)
    print("Install this CA certificate on every lab PC:", CA_CRT)
    print("(students can also download it from  http://<server>:8080/foct-lab-ca.crt )")


if __name__ == "__main__":
    main()
