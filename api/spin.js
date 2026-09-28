import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Get user IP for cooldown tracking
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const now = new Date();
    const cooldownHours = 24;

    // 1. Check Cooldown in Supabase
    const { data: cooldownData, error: cooldownError } = await supabase
        .from('user_cooldowns')
        .select('last_spun_at')
        .eq('identifier', clientIp)
        .single();

    if (cooldownData) {
        const lastSpun = new Date(cooldownData.last_spun_at);
        const hoursPassed = (now - lastSpun) / (1000 * 60 * 60);
        if (hoursPassed < cooldownHours) {
            const timeLeft = Math.ceil(cooldownHours - hoursPassed);
            return res.status(400).json({ error: `Cooldown active. Try again in ${timeLeft} hours.` });
        }
    }

    // 2. Fetch available usernames from Supabase
    const { data: usernames, error: fetchError } = await supabase
        .from('available_usernames')
        .select('*');

    if (fetchError || !usernames || usernames.length === 0) {
        return res.status(400).json({ error: 'No usernames left in stock!' });
    }

    // 3. Pick a random winner
    const randomIndex = Math.floor(Math.random() * usernames.length);
    const winnerRecord = usernames[randomIndex];

    // 4. Permanently delete the winner from Supabase so it can't be won again
    const { error: deleteError } = await supabase
        .from('available_usernames')
        .delete()
        .eq('id', winnerRecord.id);

    if (deleteError) {
        return res.status(500).json({ error: 'Internal server error during spin.' });
    }

    // 5. Update or insert the user's cooldown timestamp
    await supabase
        .from('user_cooldowns')
        .upsert({ identifier: clientIp, last_spun_at: now.toISOString() }, { onConflict: 'identifier' });

    // 6. Build the visual reel array
    const dummyPool = ['????', '----', 'xxxx', '####', '....', '1337', 'vault'];
    const reel = [];
    for (let i = 0; i < 20; i++) {
        reel.push(dummyPool[Math.floor(Math.random() * dummyPool.length)]);
    }
    reel[15] = winnerRecord.username;

    return res.status(200).json({ success: true, winner: winnerRecord.username, reel });
}