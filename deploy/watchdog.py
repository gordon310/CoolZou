#!/usr/bin/env python3
"""Record Docker failures and restart unhealthy CoolZou containers on the host."""
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import subprocess
import threading
import time

LABEL = os.environ.get('COOLZOU_WATCHDOG_LABEL', 'com.coolzou.managed=true')
LOG_DIR = Path(os.environ.get('COOLZOU_WATCHDOG_LOG_DIR', '/var/log/coolzou'))
LOG_DIR.mkdir(parents=True, exist_ok=True)
logger = logging.getLogger('coolzou-watchdog')
logger.setLevel(logging.INFO)
logger.addHandler(RotatingFileHandler(LOG_DIR / 'watchdog.jsonl', maxBytes=2_000_000, backupCount=4))


def record(event, **fields):
    logger.info(json.dumps({'time': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'event': event, **fields}))


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True, timeout=40)


def events():
    while True:
        try:
            # Capture OOM before restart clears container State.OOMKilled.
            with subprocess.Popen(['docker', 'events', '--since', '60s', '--filter', 'label=' + LABEL,
                                   '--format', '{{json .}}'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True) as proc:
                for line in proc.stdout:
                    event = json.loads(line)
                    attrs = event.get('Actor', {}).get('Attributes', {})
                    action = event.get('Action', '')
                    if action in ('oom', 'die', 'start', 'restart', 'stop', 'kill') or action.startswith('health_status:'):
                        record('docker_event', action=action, container=event.get('Actor', {}).get('ID'),
                               name=attrs.get('name'), exitCode=attrs.get('exitCode'), signal=attrs.get('signal'),
                               dockerTime=event.get('timeNano'))
        except Exception as error:
            record('event_reader_failed', error=type(error).__name__)
        time.sleep(5)


def main():
    record('watchdog_started', label=LABEL)
    threading.Thread(target=events, daemon=True).start()
    restarted = {}
    while True:
        try:
            # Running only: a deliberate docker stop must remain stopped.
            ids = docker('ps', '-q', '--filter', 'label=' + LABEL).split()
            restarted = {key: value for key, value in restarted.items() if key in ids}
            if ids:
                for container in json.loads(docker('inspect', *ids)):
                    state = container['State']
                    key = container['Id']
                    health = state.get('Health', {})
                    if not state.get('Running') or state.get('Restarting') or health.get('Status') != 'unhealthy' or time.monotonic() - restarted.get(key, -1000) < 120:
                        continue
                    record('unhealthy_restart', container=key, name=container.get('Name'),
                           failingStreak=health.get('FailingStreak'), oom=state.get('OOMKilled'),
                           healthExitCodes=[item.get('ExitCode') for item in health.get('Log', [])])
                    restarted[key] = time.monotonic()
                    docker('restart', '--time', '25', key)
                    record('restart_requested', container=key)
        except Exception as error:
            record('watchdog_check_failed', error=type(error).__name__)
        time.sleep(10)


if __name__ == '__main__':
    main()
