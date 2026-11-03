"""Download verified Linux runtimes into a dedicated workspace directory."""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile
import urllib.request
import posixpath
import shutil
import os
import platform


def read(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "HappyGit-build"}), timeout=90) as response:
        return response.read()


def fetch(url, destination, expected, algorithm):
    cached = destination.parent.parent / destination.name
    if not destination.exists() and cached.is_file() and hashlib.new(algorithm, cached.read_bytes()).hexdigest() == expected:
        shutil.copyfile(cached, destination)
    if destination.exists() and hashlib.new(algorithm, destination.read_bytes()).hexdigest() == expected:
        return
    temporary = destination.with_suffix(destination.suffix + ".partial")
    digest = hashlib.new(algorithm)
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "HappyGit-build"}), timeout=180) as response, temporary.open("wb") as target:
        while chunk := response.read(1024 * 1024):
            target.write(chunk)
            digest.update(chunk)
    if digest.hexdigest() != expected:
        raise RuntimeError("Downloaded archive checksum differs: " + destination.name)
    temporary.replace(destination)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dest", required=True)
    parser.add_argument("--hadoop", action="store_true")
    args = parser.parse_args()
    root = Path(args.dest).resolve()
    root.mkdir(parents=True, exist_ok=True)
    architecture = {"x86_64": "x64", "aarch64": "aarch64"}.get(platform.machine())
    if architecture is None:
        raise RuntimeError("Supported Linux architectures: x86_64 and aarch64")
    assets = json.loads(read("https://api.adoptium.net/v3/assets/latest/11/hotspot?architecture=" + architecture + "&image_type=jdk&os=linux"))
    package = assets[0]["binary"]["package"]
    specifications = [(package["link"], package["checksum"], "sha256")]
    base = "https://archive.apache.org/dist/maven/maven-3/3.9.11/binaries/apache-maven-3.9.11-bin.tar.gz"
    specifications.append((base, read(base + ".sha512").decode().strip().split()[0], "sha512"))
    if args.hadoop:
        base = "https://archive.apache.org/dist/hadoop/common/hadoop-3.4.2/hadoop-3.4.2.tar.gz"
        checksum = read(base + ".sha512").decode()
        import re
        found = re.search(r"\b[0-9a-fA-F]{128}\b", checksum)
        if not found:
            raise RuntimeError("Unrecognized Apache checksum format")
        specifications.append((base, found.group(0).lower(), "sha512"))
    for url, checksum, algorithm in specifications:
        archive = root / url.split("/")[-1]
        print("Preparing", archive.name, flush=True)
        fetch(url, archive, checksum, algorithm)
        with tarfile.open(archive) as source:
            for member in source.getmembers():
                target = (root / member.name).resolve()
                if os.path.commonpath([str(target), str(root)]) != str(root):
                    raise RuntimeError("Archive member escapes runtime directory")
            top = source.getmembers()[0].name.split("/")[0]
            completed = root / top / ".happygit-complete"
            if not completed.exists():
                members = {m.name.rstrip("/"): m for m in source.getmembers()}
                directory_links = []
                file_links = []
                for member in source.getmembers():
                    target = root / member.name
                    if member.isdir():
                        target.mkdir(parents=True, exist_ok=True)
                        continue
                    content = member
                    if member.issym() or member.islnk():
                        relative = posixpath.normpath(posixpath.join(posixpath.dirname(member.name), member.linkname))
                        content = members.get(relative, members.get(member.linkname))
                        if content is not None and content.isdir():
                            directory_links.append((root / content.name, target))
                            continue
                        if content is None or not content.isfile():
                            raise RuntimeError("Unresolved runtime archive link: " + member.name)
                        file_links.append((root / content.name, target))
                        continue
                    if content.isfile():
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with source.extractfile(content) as inp, target.open("wb") as out:
                            shutil.copyfileobj(inp, out)
                        os.chmod(target, content.mode & 0o777)
                for original, target in file_links:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(original, target)
                for original, target in directory_links:
                    shutil.copytree(original, target, dirs_exist_ok=True)
                completed.touch()
        print("Ready", root / top, flush=True)


if __name__ == "__main__":
    main()
