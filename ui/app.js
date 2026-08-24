async function bootstrap() {
  const details = await window.fleetRentalBot.getBootstrap();
  document.getElementById('version').textContent = `v${details.version}`;
  document.getElementById('data-directory').textContent = details.dataDirectory;
  const mode = document.getElementById('mode');
  mode.textContent = details.readOnly ? 'READ-ONLY' : 'LIVE';
  mode.classList.add(details.readOnly ? 'safe' : 'live');
}

bootstrap().catch((error) => {
  const mode = document.getElementById('mode');
  mode.textContent = 'STARTUP ERROR';
  mode.title = error instanceof Error ? error.message : String(error);
});
