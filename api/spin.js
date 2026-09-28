import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Ensure environment variables are configured correctly
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Server configuration error: Missing Supabase keys.' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Allow GET requests to fetch recent winners ticker
  if (req.method === 'GET') {
    try {
      const { data: winners, error: winnersError } = await supabase
        .from('recent_winners')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(5);

      if (winnersError) {
        return res.status(500).json({ error: 'Failed to fetch winners from database.' });
      }

      return res.status(200).json({ winners: winners || [] });
    } catch (err) {
      console.error('GET Error:', err);
      return res.status(500).json({ error: 'Failed to fetch winners' });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userToken } = req.body || {};

  if (!userToken) {
    return res.status(400).json({ error: 'Invalid session token.' });
  }

  try {
    // Check cooldown based on anonymous browser token (no IPs tracked)
    const { data: cooldownData, error: cooldownError } = await supabase
      .from('user_cooldowns')
      .select('last_spun_at')
      .eq('user_token', userToken)
      .maybeSingle();

    if (cooldownError) {
      console.error('Cooldown fetch error:', cooldownError);
    }

    if (cooldownData && cooldownData.last_spun_at) {
      const lastSpun = new Date(cooldownData.last_spun_at).getTime();
      const now = new Date().getTime();
      const hoursPassed = (now - lastSpun) / (1000 * 60 * 60);
      if (hoursPassed < 24) {
        const hoursLeft = Math.ceil(24 - hoursPassed);
        return res.status(429).json({ 
          error: `You are on cooldown. Try again in about ${hoursLeft} hours.` 
        });
      }
    }

    // Fetch available prizes
    const { data: prizes, error: fetchError } = await supabase
      .from('available_prizes')
      .select('*');

    if (fetchError || !prizes || prizes.length === 0) {
      return res.status(400).json({ error: 'No prizes left in stock!' });
    }

    // Weighted random selection algorithm
    const totalWeight = prizes.reduce((sum, p) => sum + (p.weight || 1), 0);
    let randomNum = Math.random() * totalWeight;
    let selectedPrize = prizes[0];

    for (const prize of prizes) {
      if (randomNum < (prize.weight || 1)) {
        selectedPrize = prize;
        break;
      }
      randomNum -= (prize.weight || 1);
    }

    // If it's a username, remove it from stock so it can't be won twice
    if (selectedPrize.prize_type === 'username') {
      const { error: deleteError } = await supabase
        .from('available_prizes')
        .delete()
        .eq('id', selectedPrize.id);
        
      if (deleteError) {
        console.error('Failed to remove claimed username from stock:', deleteError);
      }
    }

    // Update cooldown using the anonymous browser token
    const { error: upsertError } = await supabase.from('user_cooldowns').upsert({
      user_token: userToken,
      last_spun_at: new Date().toISOString()
    }, { onConflict: 'user_token' });

    if (upsertError) {
      console.error('Failed to update cooldown:', upsertError);
    }

    // Record win in recent_winners table
    const { error: insertError } = await supabase.from('recent_winners').insert({
      prize: selectedPrize.value,
      prize_type: selectedPrize.prize_type
    });

    if (insertError) {
      console.error('Failed to record winner:', insertError);
    }

    // Generate visual reel items
    const reel = [];
    for (let i = 0; i < 30; i++) {
      if (i === 15) {
        reel.push(selectedPrize.value);
      } else {
        const randomFiller = prizes[Math.floor(Math.random() * prizes.length)];
        reel.push(randomFiller.value);
      }
    }

    let claimMessage = '';
    if (selectedPrize.prize_type === 'username') {
      claimMessage = `Claim your username at https://guns.lol/`;
    } else {
      claimMessage = `Open a ticket with proof in discord.gg/vaultsociety to claim.`;
    }

    const { data: updatedWinners } = await supabase
      .from('recent_winners')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5);

    return res.status(200).json({
      success: true,
      prize: selectedPrize.value,
      type: selectedPrize.prize_type,
      message: claimMessage,
      reel: reel,
      winners: updatedWinners || []
    });

  } catch (err) {
    console.error('Critical server error during spin:', err);
    return res.status(500).json({ error: 'Server error during spin. Please try again later.' });
  }
}