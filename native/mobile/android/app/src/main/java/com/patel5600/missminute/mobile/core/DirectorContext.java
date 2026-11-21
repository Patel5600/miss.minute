package com.patel5600.missminute.mobile.core;

/** What the director sees when it picks. "Now" comes from the director's clock. */
public final class DirectorContext {
    public final World world;
    public final BodyState body;
    public final RoamingLevel level;
    public final Capabilities capabilities;
    public final PowerDecision power;
    public final int hourOfDay;
    public final long msSinceInteraction;

    public DirectorContext(World world, BodyState body, RoamingLevel level, Capabilities capabilities,
                           PowerDecision power, int hourOfDay, long msSinceInteraction) {
        this.world = world;
        this.body = body;
        this.level = level;
        this.capabilities = capabilities;
        this.power = power;
        this.hourOfDay = hourOfDay;
        this.msSinceInteraction = msSinceInteraction;
    }
}