import WebSocket, { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import http from 'http';

const PORT = 8080;
const clients = new Map();

// Criar servidor HTTP básico
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Servidor WebSocket rodando\n');
});

// Criar servidor WebSocket
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    const clientId = uuidv4();
    clients.set(clientId, {
        ws: ws,
        position: { x: 0, y: 5, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 }
    });

    console.log(`✓ Cliente conectado: ${clientId}`);
    console.log(`  Clientes online: ${clients.size}`);

    // Enviar ID do cliente para ele
    ws.send(JSON.stringify({
        type: 'init',
        clientId: clientId
    }));

    // Informar novo cliente sobre os clientes existentes
    for (const [existingId, existingClient] of clients) {
        if (existingId !== clientId) {
            ws.send(JSON.stringify({
                type: 'update',
                clientId: existingId,
                position: existingClient.position,
                rotation: existingClient.rotation
            }));
        }
    }

    // Notificar outros sobre o novo cliente
    broadcast(JSON.stringify({
        type: 'update',
        clientId: clientId,
        position: clients.get(clientId).position,
        rotation: clients.get(clientId).rotation
    }), clientId);

    // Lidar com mensagens
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);

            if (message.type === 'update' && message.clientId === clientId) {
                const client = clients.get(clientId);
                if (client) {
                    client.position = message.position;
                    client.rotation = message.rotation;

                    // Broadcast para outros clientes
                    broadcast(JSON.stringify({
                        type: 'update',
                        clientId: clientId,
                        position: message.position,
                        rotation: message.rotation
                    }), clientId);
                }
            }
        } catch (error) {
            console.error('Erro ao processar mensagem:', error);
        }
    });

    // Lidar com desconexão
    ws.on('close', () => {
        clients.delete(clientId);
        console.log(`✗ Cliente desconectado: ${clientId}`);
        console.log(`  Clientes online: ${clients.size}`);

        // Notificar outros sobre a desconexão
        broadcast(JSON.stringify({
            type: 'disconnect',
            clientId: clientId
        }), null);
    });

    ws.on('error', (error) => {
        console.error(`Erro do cliente ${clientId}:`, error);
    });
});

function broadcast(message, excludeClientId) {
    for (const [clientId, client] of clients) {
        if (clientId !== excludeClientId && client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(message);
        }
    }
}

// Iniciar servidor
server.listen(PORT, () => {
    console.log('');
    console.log('╔════════════════════════════════════════╗');
    console.log('║     🚀 Servidor WebSocket Ativo       ║');
    console.log('╠════════════════════════════════════════╣');
    console.log(`║  Porta: ${PORT}`);
    console.log(`║  Endereço: ws://localhost:${PORT}      ║`);
    console.log('║  Aguardando conexões...               ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('');
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\nEncerrando servidor...');
    wss.close(() => {
        console.log('Servidor WebSocket encerrado');
        process.exit(0);
    });
});